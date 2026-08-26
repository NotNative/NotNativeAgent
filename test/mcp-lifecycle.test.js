// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { ContractError } from '../src/ids.js';
import { McpManager } from '../src/mcp-manager.js';
import { HttpMcpTransport, MCP_CURRENT_VERSION } from '../src/mcp-transport.js';

const registry = () => ({ installExternal() {}, revokeSource() {} });

test('AC-MCP-02 exposes authenticating state and applies independent shutdown deadline', async () => {
  let finishInitialize;
  const initialized = new Promise((resolve) => { finishInitialize = resolve; });
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {},
    async request(method) {
      if (method === 'initialize') { await initialized; return { protocolVersion: MCP_CURRENT_VERSION, capabilities: {} }; }
      return { tools: [] };
    },
    async close() { return new Promise(() => undefined); },
    async notify() {},
  };
  const config = mcpConfig({ credential_env: 'NNA_TEST_MCP_TOKEN', shutdown_timeout_ms: 100 });
  const manager = new McpManager({ registry: registry(), configs: config.mcpServers, transportFactory: () => transport });
  const opening = manager.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.status()[0].state, 'authenticating');
  finishInitialize();
  await opening;
  assert.equal(manager.status()[0].state, 'ready');
  const started = performance.now();
  await manager.close();
  assert.ok(performance.now() - started < 500);
  assert.equal(manager.status()[0].state, 'closed');
  assert.equal(manager.status()[0].lastError, 'mcp_timeout');
});

test('AC-MCP-03 capability changes replace only the next snapshot and preserve prior definitions', async () => {
  let tools = [{ name: 'first', description: 'first tool', inputSchema: { type: 'object', properties: {} } }];
  const active = new Map();
  const history = new Map();
  const trackedRegistry = {
    installExternal(definition) {
      active.set(definition.name, definition);
      history.set(`${definition.name}@${definition.version}`, definition);
    },
    revokeSource(source) {
      for (const [name, definition] of active) if (definition.source === source) active.delete(name);
    },
  };
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() {}, async notify() {},
    async request(method) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: { listChanged: true } } };
      if (method === 'tools/list') return { tools };
      return {};
    },
  };
  const manager = new McpManager({ registry: trackedRegistry, configs: mcpConfig().mcpServers, transportFactory: () => transport });
  await manager.initialize();
  const currentStepSnapshot = Object.freeze([...active.keys()]);
  assert.deepEqual(currentStepSnapshot, ['mcp.remote.first']);
  tools = [{ name: 'second', description: 'second tool', inputSchema: { type: 'object', properties: {} } }];
  assert.equal(await manager.handleNotification('remote', { method: 'notifications/tools/list_changed' }), true);
  assert.deepEqual(currentStepSnapshot, ['mcp.remote.first']);
  assert.deepEqual([...active.keys()], ['mcp.remote.second']);
  assert.equal(history.get('mcp.remote.first@1').name, 'mcp.remote.first');
  assert.equal(history.get('mcp.remote.second@2').name, 'mcp.remote.second');
});

test('AC-MCP-04 configured header references resolve only at the HTTP boundary', async (t) => {
  let received;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    received = request.headers['x-workspace-token'];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 'ignored', result: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const prior = process.env.NNA_TEST_HEADER_SECRET;
  process.env.NNA_TEST_HEADER_SECRET = 'boundary-secret';
  t.after(() => {
    if (prior === undefined) delete process.env.NNA_TEST_HEADER_SECRET;
    else process.env.NNA_TEST_HEADER_SECRET = prior;
  });
  const transport = new HttpMcpTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`, protocolVersion: MCP_CURRENT_VERSION,
    headerEnv: { 'X-Workspace-Token': 'NNA_TEST_HEADER_SECRET' },
  });
  await transport.request('ping');
  assert.equal(received, 'boundary-secret');
  assert.equal(JSON.stringify(transport.config).includes('boundary-secret'), false);
});

test('structured Secret Broker header credentials resolve only at the HTTP boundary', async (t) => {
  let received;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    received = request.headers['x-workspace-token'];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 'ignored', result: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const credentialResolver = {
    async withCredential(binding, _context, consumer) {
      return consumer(binding ? 'broker-boundary-secret' : null);
    },
  };
  const config = {
    id: 'remote', endpoint: `http://127.0.0.1:${server.address().port}/mcp`, protocolVersion: MCP_CURRENT_VERSION,
    headerCredentials: { 'X-Workspace-Token': { source: 'secret', secretId: 'sec_123', field: 'token' } },
  };
  const transport = new HttpMcpTransport(config, { credentialResolver });
  await transport.request('ping');
  assert.equal(received, 'broker-boundary-secret');
  assert.equal(JSON.stringify(config).includes('broker-boundary-secret'), false);
});

test('AC-MCP-02 stateful HTTP session shutdown is bounded and explicitly released', async (t) => {
  const protocolVersion = '2025-11-25';
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    requests.push({ method: request.method, session: request.headers['mcp-session-id'] });
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-fixture' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 'ignored', result: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const transport = new HttpMcpTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`, protocolVersion,
  });

  await transport.request('ping');
  await transport.close(AbortSignal.timeout(1_000));
  assert.deepEqual(requests, [
    { method: 'POST', session: undefined },
    { method: 'DELETE', session: 'session-fixture' },
  ]);
});

test('AC-MCP-06 unsupported future protocol fails actionably and remains isolated', async () => {
  let closed = 0;
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() { closed += 1; }, async notify() {},
    async request(method) {
      if (method === 'initialize') return { protocolVersion: '2099-01-01', capabilities: {} };
      return { tools: [] };
    },
  };
  const manager = new McpManager({ registry: registry(), configs: mcpConfig().mcpServers, transportFactory: () => transport });
  const result = await manager.initialize();
  assert.equal(result[0].status, 'failed');
  assert.equal(manager.status()[0].lastError, 'mcp_version_mismatch');
  assert.equal(closed, 1);
});

test('AC-MCP-02 initialized notification is deadline-bound and failed startup closes transport', async () => {
  let closed = 0;
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {},
    async request() { return { protocolVersion: MCP_CURRENT_VERSION, capabilities: {} }; },
    async notify() { return new Promise(() => undefined); }, async close() { closed += 1; },
  };
  const manager = new McpManager({
    registry: registry(), configs: mcpConfig({ list_timeout_ms: 100, shutdown_timeout_ms: 100 }).mcpServers,
    transportFactory: () => transport,
  });
  const started = performance.now();
  const result = await manager.initialize();
  assert.ok(performance.now() - started < 500);
  assert.equal(result[0].status, 'degraded');
  assert.equal(manager.status()[0].lastError, 'mcp_timeout');
  assert.equal(closed, 1);
});

test('AC-MCP-03 failed capability refresh revokes stale tools and degrades only that server', async () => {
  let notification; let failList = false; let revoked = 0;
  const trackedRegistry = {
    installExternal() {}, revokeSource() { revoked += 1; },
  };
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() {}, async notify() {},
    onNotification(handler) { notification = handler; },
    async request(method) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: { listChanged: true } } };
      if (failList) throw Object.assign(new Error('offline'), { code: 'mcp_list_failed', retryable: true });
      return { tools: [{ name: 'old', inputSchema: { type: 'object', properties: {} } }] };
    },
  };
  const manager = new McpManager({ registry: trackedRegistry, configs: mcpConfig().mcpServers, transportFactory: () => transport });
  await manager.initialize(); failList = true;
  await notification({ method: 'notifications/tools/list_changed' });
  assert.equal(manager.status()[0].state, 'degraded');
  assert.equal(manager.status()[0].lastError, 'mcp_list_failed');
  assert.equal(revoked, 1);
});

test('MCP capability notification bursts coalesce into a bounded refresh sequence', async () => {
  let notification; let markRefreshStarted; let finishRefresh; let listCalls = 0;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const refreshGate = new Promise((resolve) => { finishRefresh = resolve; });
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() {}, async notify() {},
    onNotification(handler) { notification = handler; },
    async request(method) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: { listChanged: true } } };
      listCalls += 1;
      if (listCalls === 2) { markRefreshStarted(); await refreshGate; }
      return { tools: [] };
    },
  };
  const manager = new McpManager({
    registry: registry(), configs: mcpConfig().mcpServers, transportFactory: () => transport,
  });
  await manager.initialize();
  const first = notification({ method: 'notifications/tools/list_changed' });
  await refreshStarted;
  const notifications = Array.from({ length: 99 }, () => (
    notification({ method: 'notifications/tools/list_changed' })
  ));
  finishRefresh();
  await Promise.all([first, ...notifications]);
  assert.equal(listCalls, 3);
  await manager.close();
});

test('AC-MCP-05 in-flight transport failure revokes capabilities and reconnect never replays the call', async () => {
  let transportGeneration = 0; let toolCalls = 0;
  const active = new Map();
  const trackedRegistry = {
    installExternal(definition) { active.set(definition.name, definition); },
    revokeSource(source) {
      for (const [name, definition] of active) if (definition.source === source) active.delete(name);
    },
  };
  const transportFactory = () => {
    transportGeneration += 1;
    const generation = transportGeneration;
    return {
      protocolVersion: MCP_CURRENT_VERSION,
      async open() {
        if (generation === 2) throw new ContractError('mcp_closed', 'still offline', true);
      },
      async close() {}, async notify() {},
      async request(method) {
        if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: {} } };
        if (method === 'tools/list') return { tools: [{ name: 'mutate', inputSchema: { type: 'object', properties: {} } }] };
        if (method === 'tools/call') {
          toolCalls += 1;
          throw new ContractError('mcp_closed', 'connection lost after dispatch', true);
        }
        return {};
      },
    };
  };
  const manager = new McpManager({ registry: trackedRegistry, configs: mcpConfig().mcpServers, transportFactory });
  await manager.initialize();
  const tool = active.get('mcp.remote.mutate');

  await assert.rejects(tool.executor({ args: {} }, new AbortController().signal), { code: 'mcp_closed' });
  assert.equal(manager.status()[0].state, 'degraded');
  assert.deepEqual([...active.keys()], []);
  await manager.reconnect('remote', 3);
  assert.equal(manager.status()[0].state, 'ready');
  assert.equal(toolCalls, 1);
  assert.equal(transportGeneration, 3);
});

test('AC-MCP-03 late capability refresh cannot reinstall tools after shutdown', async () => {
  let notification; let finishRefresh; let listCalls = 0;
  const refresh = new Promise((resolve) => { finishRefresh = resolve; });
  const active = new Map();
  const trackedRegistry = {
    installExternal(definition) { active.set(definition.name, definition); },
    revokeSource(source) {
      for (const [name, definition] of active) if (definition.source === source) active.delete(name);
    },
  };
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() {}, async notify() {},
    onNotification(handler) { notification = handler; },
    async request(method) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: { listChanged: true } } };
      listCalls += 1;
      if (listCalls === 1) return { tools: [{ name: 'old', inputSchema: { type: 'object', properties: {} } }] };
      await refresh;
      return { tools: [{ name: 'late', inputSchema: { type: 'object', properties: {} } }] };
    },
  };
  const manager = new McpManager({ registry: trackedRegistry, configs: mcpConfig().mcpServers, transportFactory: () => transport });
  await manager.initialize();
  const refreshing = notification({ method: 'notifications/tools/list_changed' });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.close(); finishRefresh(); await refreshing;
  assert.equal(manager.status()[0].state, 'closed');
  assert.deepEqual([...active.keys()], []);
});

test('MCP configuration validates independent deadlines and secret header references', () => {
  const config = mcpConfig({
    connect_timeout_ms: 101, list_timeout_ms: 102, call_timeout_ms: 103, shutdown_timeout_ms: 104,
    header_env: { 'X-Token': 'MCP_TOKEN' }, trusted: true,
  }).mcpServers[0];
  assert.deepEqual([config.connectTimeoutMs, config.listTimeoutMs, config.callTimeoutMs, config.shutdownTimeoutMs], [101, 102, 103, 104]);
  assert.deepEqual(config.headerEnv, { 'X-Token': 'MCP_TOKEN' });
  assert.equal(config.trusted, true);
  assert.throws(() => mcpConfig({ header_env: { Authorization: 'TOKEN' } }), { code: 'invalid_mcp_headers' });
  assert.throws(() => mcpConfig({ endpoint: 'https://secret@example.test/mcp' }), { code: 'invalid_endpoint' });
});

function mcpConfig(overrides = {}) {
  return resolveManifest({
    persistence: 'ephemeral',
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'm', trust_zone: 'loopback' },
    mcp_servers: [{
      id: 'remote', transport: 'streamable_http', endpoint: 'https://mcp.example.test/service', enabled: true,
      ...overrides,
    }],
  });
}
