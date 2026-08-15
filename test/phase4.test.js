// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { ContractError } from '../src/ids.js';
import { SessionEngine } from '../src/engine.js';
import { ExtensionRegistry } from '../src/extensions.js';
import { HttpMcpTransport, MCP_CURRENT_VERSION } from '../src/mcp-transport.js';
import { createServer } from 'node:http';

function base(root, extra = {}) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: {
      id: 'primary', endpoint: 'http://127.0.0.1:9999/v1', model: 'primary-model',
      trust_zone: 'loopback', capabilities: { images: true },
    },
    ...extra,
  });
}

test('AC-ATT-01/AC-ROUTE-04 primary-first image fallback returns a tool-less attributed vision observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attachment-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    providers: [
      { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'p', trust_zone: 'loopback', capabilities: { images: true } },
      { id: 'vision', endpoint: 'http://127.0.0.1:2/v1', model: 'v', trust_zone: 'loopback', capabilities: { images: true } },
    ],
    routes: { vision: { provider_id: 'vision' } },
  });
  let primaryCalls = 0;
  let taskRequest;
  const providerCalls = [];
  const statuses = [];
  const factory = (profile) => ({ async *stream(request) {
    providerCalls.push(profile.id);
    if (profile.id === 'vision') {
      assert.equal(request.tools.length, 0);
      yield { type: 'text', text: 'a blue square' };
      yield { type: 'terminal' };
      return;
    }
    primaryCalls += 1;
    if (primaryCalls === 1) throw new ContractError('provider_image_unsupported', 'unsupported');
    taskRequest = request;
    yield { type: 'text', text: 'done' };
    yield { type: 'terminal' };
  } });
  const engine = new SessionEngine({
    config, providerFactory: factory, attachmentRoot: join(root, '.managed'),
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event.state); },
  });
  await engine.initialize();
  const result = await engine.submit({
    request_id: 'attachment-turn', content: 'Inspect this',
    attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.attachment_admission.admitted[0].route, 'vision');
  assert.deepEqual(statuses, ['staged', 'admitted']);
  assert.match(taskRequest.messages.find((item) => item.content?.includes?.('a blue square')).content, /untrusted attachment/iu);
  const followup = await engine.submit({ request_id: 'attachment-followup', content: 'Continue without an image' }, 'operator');
  assert.equal(followup.outcome, 'completed');
  assert.deepEqual(providerCalls, ['primary', 'vision', 'primary', 'primary']);
  assert.equal(await readFile(image, 'hex'), '89504e470d0a1a0a00000000');
});

test('primary image attempt is never bypassed by declarations or a prior rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-primary-image-retry-'));
  const firstImage = join(root, 'first.png');
  const secondImage = join(root, 'second.png');
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  await writeFile(firstImage, png);
  await writeFile(secondImage, png);
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    providers: [
      { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'p', trust_zone: 'loopback', capabilities: { images: false } },
      { id: 'vision', endpoint: 'http://127.0.0.1:2/v1', model: 'v', trust_zone: 'loopback', capabilities: { images: true } },
    ],
    routes: { vision: { provider_id: 'vision' } },
  });
  let primaryImageAttempts = 0;
  let visionCalls = 0;
  const factory = (profile) => ({ async *stream(request) {
    const imageRequest = Array.isArray(request.messages?.[0]?.content);
    if (profile.id === 'vision') {
      visionCalls += 1;
      yield { type: 'text', text: 'fallback observation' };
      yield { type: 'terminal' };
      return;
    }
    if (imageRequest) {
      primaryImageAttempts += 1;
      if (primaryImageAttempts === 1) throw new ContractError('provider_image_unsupported', 'unsupported');
      yield { type: 'text', text: 'primary observation' };
      yield { type: 'terminal' };
      return;
    }
    yield { type: 'text', text: 'done' };
    yield { type: 'terminal' };
  } });
  const engine = new SessionEngine({ config, providerFactory: factory, attachmentRoot: join(root, '.managed') });
  await engine.initialize();
  const first = await engine.submit({
    request_id: 'first-image', content: 'Inspect first', attachments: [{ path: firstImage, mime_type: 'image/png' }],
  }, 'operator');
  const second = await engine.submit({
    request_id: 'second-image', content: 'Inspect second', attachments: [{ path: secondImage, mime_type: 'image/png' }],
  }, 'operator');
  assert.equal(first.attachment_admission.admitted[0].route, 'vision');
  assert.equal(second.attachment_admission.admitted[0].route, 'primary');
  assert.equal(primaryImageAttempts, 2);
  assert.equal(visionCalls, 1);
});

test('AC-ATT-02 no eligible vision route rejects managed copy and retains text for retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-no-vision-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00', 'hex'));
  const provider = { async *stream() { throw new ContractError('provider_image_unsupported', 'unsupported'); } };
  const statuses = [];
  const engine = new SessionEngine({
    config: base(root), providerFactory: () => provider, attachmentRoot: join(root, '.managed'),
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event); },
  });
  const result = await engine.submit({
    request_id: 'rejected-image', content: 'Keep this instruction',
    attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  assert.equal(result.outcome, 'needs_input');
  assert.equal(result.failure.code, 'attachment_partial_admission');
  assert.equal(result.failure.pending_text, 'Keep this instruction');
  assert.equal(result.attachment_admission.failures[0].state, 'rejected');
  assert.deepEqual(statuses.map((item) => item.state), ['staged', 'rejected']);
  assert.match(statuses[1].guidance, /removed and not analyzed.*Configure.*then reattach/iu);
  await assert.rejects(readFile(result.attachment_admission.failures[0].managedPath), { code: 'ENOENT' });
  assert.equal((await readFile(image)).length, 9);
});

test('AC-ATT-03 temporary failure retries same identity only on explicit control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attachment-retry-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00', 'hex'));
  let call = 0;
  const statuses = [];
  const provider = { async *stream(request) {
    call += 1;
    if (call === 1) throw new ContractError('provider_transient', 'temporary', true);
    if (call === 2) {
      assert.equal(Array.isArray(request.messages[0].content), true);
      yield { type: 'text', text: 'recovered observation' }; yield { type: 'terminal' };
      return;
    }
    yield { type: 'text', text: 'finished' }; yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: base(root), providerFactory: () => provider, attachmentRoot: join(root, '.managed'),
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event.state); },
  });
  const first = await engine.submit({
    request_id: 'temporary-image', content: 'Inspect',
    attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  const pending = first.attachment_admission.failures[0];
  assert.equal(pending.state, 'pending_failed');
  assert.equal(call, 1);
  const retried = await engine.retryAttachment({
    request_id: 'retry-image', attachment_id: pending.id, content: 'Inspect',
  }, 'operator');
  assert.equal(retried.outcome, 'completed');
  assert.equal(retried.attachment_admission.admitted[0].id, pending.id);
  assert.equal((await engine.removeAttachment({ request_id: 'remove-image', attachment_id: pending.id })).accepted, true);
  assert.deepEqual(statuses, ['staged', 'pending_failed', 'admitted', 'removed']);
});

test('AC-ATT-02/SESS-015 failed managed cleanup is persisted and never presented as removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attachment-cleanup-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00', 'hex'));
  const statuses = [];
  const cleanupError = Object.assign(new Error('locked'), { code: 'EBUSY' });
  const engine = new SessionEngine({
    config: base(root), attachmentRoot: join(root, '.managed'),
    providerFactory: () => ({ async *stream() { throw new ContractError('provider_image_unsupported', 'unsupported'); } }),
    attachmentRemoveFile: async () => { throw cleanupError; },
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event); },
  });
  const result = await engine.submit({
    request_id: 'cleanup-image', content: 'Keep text', attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  const failure = result.attachment_admission.failures[0];
  assert.equal(failure.state, 'cleanup_failed');
  assert.deepEqual(statuses.map((item) => item.state), ['staged', 'cleanup_failed']);
  assert.match(statuses[1].guidance, /could not be removed/u);
  await assert.rejects(engine.removeAttachment({ request_id: 'cleanup-remove', attachment_id: failure.id }), {
    code: 'attachment_cleanup_failed',
  });
  assert.notEqual(statuses.at(-1).state, 'removed');
});

test('analyzed attachment cleanup failure preserves its observation and authoritative state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attachment-admitted-cleanup-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00', 'hex'));
  const statuses = [], requests = [];
  const engine = new SessionEngine({
    config: base(root), attachmentRoot: join(root, '.managed'),
    providerFactory: () => ({ async *stream(request) {
      requests.push(request);
      yield { type: 'text', text: Array.isArray(request.messages[0]?.content) ? 'observed image' : 'used observation' };
      yield { type: 'terminal', finishReason: 'stop' };
    } }),
    attachmentRemoveFile: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event); },
  });
  const result = await engine.submit({
    request_id: 'admitted-cleanup-image', content: 'Inspect this image',
    attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  const admitted = result.attachment_admission.admitted[0];
  assert.equal(result.outcome, 'completed');
  assert.equal(admitted.state, 'cleanup_failed');
  assert.equal(admitted.observation, 'observed image');
  assert.deepEqual(statuses.map((item) => item.state), ['staged', 'admitted', 'cleanup_failed']);
  assert.match(JSON.stringify(requests[1].messages), /observed image/u);
});

test('AC-STATE-04 attachment cancellation does not await or admit a late provider result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attachment-cancel-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a00', 'hex'));
  let releaseProvider; let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const statuses = [];
  const provider = { async *stream() {
    markStarted();
    await new Promise((resolve) => { releaseProvider = resolve; });
    yield { type: 'text', text: 'late observation' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: base(root), providerFactory: () => provider, attachmentRoot: join(root, '.managed'),
    output: async (event) => { if (event.type === 'attachment_status') statuses.push(event); },
  });

  const turn = engine.submit({
    request_id: 'cancel-image-turn', content: 'Inspect',
    attachments: [{ path: image, mime_type: 'image/png' }],
  }, 'operator');
  await started;
  await engine.cancel({ request_id: 'cancel-image-control' });
  const result = await turn;
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(statuses.map((item) => item.state), ['staged', 'pending_failed']);
  assert.equal(statuses.at(-1).reason, 'attachment_cancelled');
  releaseProvider();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.some((item) => item.state === 'admitted'), false);
});

test('AC-MEM-01/AC-MEM-02/AC-MEM-03/AC-PRIV-02 recall is governed, attributed, scope-specific, bounded, and deterministic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-'));
  let received;
  const memoryAdapter = { async query(request) {
    received = request;
    return [
      { id: 'b', scope: request.scope, content: 'lower', relevance: 0.2, updatedAt: 20 },
      { id: 'a', scope: request.scope, content: 'pinned fact', relevance: 0.1, pinned: true, updatedAt: 1 },
      { id: 'user-stale', scope: 'user', content: 'older user fact', relevance: 0.9, stale: true, conflict: true, updatedAt: 30, source: 'fixture-user' },
      { id: 'foreign', scope: 'project:other', content: 'secret project', relevance: 1 },
    ];
  } };
  let providerRequest;
  const provider = { async *stream(request) {
    providerRequest = request;
    yield { type: 'text', text: 'done' }; yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: base(root, { memory: { enabled: true, max_items: 3 } }), memoryAdapter,
    providerFactory: () => provider,
  });
  await engine.submit({ request_id: 'memory-turn', content: 'Recall context' }, 'operator');
  assert.equal(received.query, 'Recall context');
  const memories = providerRequest.messages.filter((item) => item.content?.startsWith?.('Untrusted recalled memory'));
  assert.equal(memories.length, 2);
  assert.match(memories[0].content, /pinned fact/u);
  assert.match(memories[0].content, /assertion assertable_with_attribution/u);
  assert.equal(providerRequest.messages.some((item) => item.content?.includes?.('older user fact')), false);
  assert.doesNotMatch(JSON.stringify(providerRequest), /secret project/u);
  const audit = engine.governance.audit().filter((item) => item.domain === 'memory_eligibility');
  assert.equal(audit.length, 3);
  assert.equal(audit.filter((item) => item.outcome === 'quarantine').length, 1);
});

test('AC-MEM-04 optional timeout degrades visibly and does not block the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-timeout-'));
  const outputs = [];
  const memoryAdapter = { async query() { return new Promise(() => {}); } };
  const provider = { async *stream() { yield { type: 'text', text: 'continued' }; yield { type: 'terminal' }; } };
  const engine = new SessionEngine({
    config: base(root, { memory: { enabled: true, timeout_ms: 50 } }), memoryAdapter,
    providerFactory: () => provider, output: async (item) => outputs.push(item),
  });
  const result = await engine.submit({ request_id: 'memory-timeout', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(outputs.find((item) => item.type === 'memory_status').status, 'degraded');
});

test('AC-MEM-01/AC-MEM-05 cancellation aborts correlated recall and discards its late result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-cancel-'));
  let releaseQuery; let received; let providerCalls = 0;
  let queryStarted;
  const started = new Promise((resolve) => { queryStarted = resolve; });
  const memoryAdapter = { async query(request) {
    received = request;
    queryStarted();
    return new Promise((resolve) => { releaseQuery = resolve; });
  } };
  const engine = new SessionEngine({
    config: base(root, { memory: { enabled: true, timeout_ms: 1_000 } }), memoryAdapter,
    providerFactory: () => ({ async *stream() { providerCalls += 1; yield { type: 'terminal' }; } }),
  });

  const turn = engine.submit({ request_id: 'memory-cancel-turn', content: 'Recall then stop' }, 'operator');
  await started;
  await engine.cancel({ request_id: 'memory-cancel-control' });
  const result = await turn;
  assert.equal(result.outcome, 'cancelled');
  assert.match(received.requestId, /^memory_request_/u);
  assert.equal(received.signal.aborted, true);
  assert.equal(providerCalls, 0);
  releaseQuery([{ id: 'late', scope: received.scope, content: 'must not enter context' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 0);
});

test('AC-MEM-05 explicit save rejects secret-like content before adapter access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-secret-'));
  let saves = 0;
  const memoryAdapter = {
    async query() { return []; }, async save() { saves += 1; return { version: 1 }; },
  };
  const engine = new SessionEngine({
    config: base(root, { memory: { enabled: true } }), memoryAdapter,
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'x' }; yield { type: 'terminal' }; } }),
  });
  await assert.rejects(engine.saveMemory('api_key=super-secret-value'), { code: 'memory_secret_rejected' });
  assert.equal(saves, 0);
});

test('AC-MEM-06 same-identity writes require optimistic versions and surface a conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-conflict-'));
  let version = 1;
  const memoryAdapter = { async save(record) {
    if (record.expectedVersion !== version) throw new ContractError('memory_version_conflict', 'memory changed');
    version += 1;
    return { id: record.id, version };
  } };
  const engine = new SessionEngine({
    config: base(root, { memory: { enabled: true } }), memoryAdapter,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await assert.rejects(engine.saveMemory('update', { id: 'same' }), { code: 'memory_version_required' });
  const results = await Promise.allSettled([
    engine.saveMemory('first update', { id: 'same', expectedVersion: 1 }),
    engine.saveMemory('second update', { id: 'same', expectedVersion: 1 }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected')[0].reason.code, 'memory_version_conflict');
});

test('AC-MCP-01/03 discovered MCP tool uses namespace, reviewer, and ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-'));
  let remoteCalls = 0;
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION, async open() {}, async close() {},
    async request(method, params) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: {} } };
      if (method === 'tools/list') return { tools: [{
        name: 'lookup', description: 'Remote lookup',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      }] };
      remoteCalls += 1;
      assert.deepEqual(params, { name: 'lookup', arguments: { key: 'alpha' } });
      return { content: [{ type: 'text', text: 'remote value' }], isError: false };
    },
  };
  let step = 0;
  const provider = { async *stream() {
    step += 1;
    if (step === 1) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'mcp-call', function: {
        name: 'mcp.catalog.lookup', arguments: '{"key":"alpha"}',
      } }] };
      yield { type: 'terminal' };
      return;
    }
    yield { type: 'text', text: 'handled' }; yield { type: 'terminal' };
  } };
  const semanticReviewer = { async review() {
    return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' };
  } };
  const engine = new SessionEngine({
    config: base(root, { mcp_servers: [{
      id: 'catalog', transport: 'streamable_http', endpoint: 'http://127.0.0.1:9998/mcp',
      enabled: true, tool_effects: { lookup: 'read_only' },
    }] }),
    providerFactory: () => provider, semanticReviewer, mcpTransportFactory: () => transport,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'mcp-turn', content: 'Use catalog lookup for alpha' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(remoteCalls, 1);
  assert.equal(engine.reviewerAudit()[0].decision, 'approve');
  assert.equal(engine.reviewerAudit()[0].result, 'succeeded');
  await engine.shutdown({ request_id: 'mcp-shutdown' });
});

test('AC-MCP-05 one failed MCP server is isolated from a ready peer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-isolation-'));
  const statuses = [];
  const configs = ['bad', 'good'].map((id) => ({
    id, transport: 'streamable_http', endpoint: `http://127.0.0.1:9/${id}`, enabled: true,
  }));
  const factory = (config) => ({
    protocolVersion: MCP_CURRENT_VERSION,
    async open() { if (config.id === 'bad') throw new ContractError('mcp_down', 'down', true); },
    async request(method) {
      if (method === 'initialize') return { protocolVersion: MCP_CURRENT_VERSION, capabilities: { tools: {} } };
      return { tools: [] };
    }, async close() {},
  });
  const engine = new SessionEngine({
    config: base(root, { mcp_servers: configs }), mcpTransportFactory: factory,
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
    output: async (item) => { if (item.type === 'mcp_status') statuses.push(item); },
  });
  await engine.initialize();
  assert.deepEqual(statuses.map((item) => [item.id, item.status]), [['bad', 'degraded'], ['good', 'ready']]);
});

test('interactive startup defers unavailable MCP discovery and shutdown cancels it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-deferred-startup-'));
  let requestStarted = false;
  let requestCancelled = false;
  const transport = {
    protocolVersion: MCP_CURRENT_VERSION,
    async open() {},
    async request(_method, _params, signal) {
      requestStarted = true;
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          requestCancelled = true;
          reject(new ContractError('mcp_cancelled', 'cancelled'));
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    },
    async close() {},
    async notify() {},
  };
  const engine = new SessionEngine({
    config: base(root, { mcp_servers: [{
      id: 'offline', transport: 'streamable_http', endpoint: 'http://127.0.0.1:9/mcp',
      enabled: true, connect_timeout_ms: 5_000, list_timeout_ms: 5_000,
    }] }),
    mcpTransportFactory: () => transport,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal', finishReason: 'stop' }; } }),
  });

  const started = performance.now();
  await engine.initialize({ deferMcp: true });
  assert.ok(performance.now() - started < 500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestStarted, true);
  assert.equal(engine.mcp.status()[0].state, 'connecting');

  await engine.shutdown({ request_id: 'deferred-mcp-shutdown' });
  await engine.mcpInitialization;
  assert.equal(requestCancelled, true);
  assert.equal(engine.mcp.status()[0].state, 'closed');
});

test('AC-MCP-06 current Streamable HTTP mirrors stateless routing metadata', async (t) => {
  let captured;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    captured = { headers: request.headers, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: captured.body.id, result: { content: [] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const transport = new HttpMcpTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`, protocolVersion: MCP_CURRENT_VERSION,
  });
  await transport.request('tools/call', { name: 'lookup', arguments: {} }, new AbortController().signal);
  assert.equal(captured.headers['mcp-protocol-version'], MCP_CURRENT_VERSION);
  assert.equal(captured.headers['mcp-method'], 'tools/call');
  assert.equal(captured.headers['mcp-name'], 'lookup');
  assert.equal(captured.headers['mcp-session-id'], undefined);
  assert.equal(captured.body.params._meta['io.modelcontextprotocol/protocolVersion'], MCP_CURRENT_VERSION);
});

test('AC-PLUG-01/AC-PLUG-02 extension requires provenance and unload revokes lifecycle', async () => {
  const registry = new ExtensionRegistry();
  let closed = false;
  let cancelled = false;
  assert.throws(() => registry.register({ id: 'bad', enabled: true }, () => ({})), { code: 'invalid_extension_manifest' });
  const installed = registry.install({
    id: 'fixture.ext', origin: 'local-test', version: '1.0.0', license: 'Apache-2.0',
    host_contract_version: '1.0', capabilities: ['diagnostics'], permissions: ['diagnostics.emit'],
    configuration_schema: { type: 'object', additionalProperties: false }, lifecycle: { shutdown_timeout_ms: 500 },
  }, (host) => {
    host.signal.addEventListener('abort', () => { cancelled = true; });
    return { async close() { closed = true; } };
  });
  assert.equal(installed.state, 'installed');
  assert.deepEqual(installed.permissions, ['diagnostics.emit']);
  assert.throws(() => registry.enable('fixture.ext'), { code: 'extension_enable_confirmation_required' });
  assert.equal(registry.enable('fixture.ext', 'enable:fixture.ext').state, 'ready');
  assert.deepEqual(registry.capabilities(), [{ extension_id: 'fixture.ext', capability: 'diagnostics' }]);
  assert.equal(await registry.unload('fixture.ext'), true);
  assert.equal(cancelled, true);
  assert.equal(closed, true);
  assert.deepEqual(registry.capabilities(), []);
});

test('AC-PLUG-02 incompatible and crashing extensions remain isolated and disabled', () => {
  const registry = new ExtensionRegistry();
  const manifest = {
    id: 'future.ext', origin: 'local-test', version: '2.0.0', license: 'Apache-2.0',
    host_contract_version: '2.0', capabilities: ['future'], permissions: [],
    configuration_schema: {}, lifecycle: {},
  };
  assert.equal(registry.install(manifest, () => ({})).state, 'incompatible');
  assert.match(registry.enable('future.ext', 'enable:future.ext').diagnostic, /incompatible/u);
  const failed = { ...manifest, id: 'failed.ext', host_contract_version: '1.0' };
  registry.install(failed, () => { throw new Error('private initialization failure'); });
  assert.equal(registry.enable('failed.ext', 'enable:failed.ext').state, 'failed');
  assert.deepEqual(registry.capabilities(), []);
  assert.equal(registry.diagnostics()[0].code, 'extension_initialization_failed');
});

test('AC-PLUG-02 extension registry close cancels and closes every active extension', async () => {
  const registry = new ExtensionRegistry();
  const effects = [];
  for (const id of ['one.ext', 'two.ext']) {
    registry.install({
      id, origin: 'local-test', version: '1.0.0', license: 'Apache-2.0',
      host_contract_version: '1.0', capabilities: ['diagnostics'], permissions: [],
      configuration_schema: {}, lifecycle: { shutdown_timeout_ms: 500 },
    }, (host) => {
      host.signal.addEventListener('abort', () => effects.push(`abort:${id}`));
      return { async close() { effects.push(`close:${id}`); } };
    });
    registry.enable(id, `enable:${id}`);
  }
  const states = await registry.close();
  assert.deepEqual(states.map((item) => item.state), ['disabled', 'disabled']);
  assert.deepEqual(effects.sort(), ['abort:one.ext', 'abort:two.ext', 'close:one.ext', 'close:two.ext']);
  assert.deepEqual(registry.capabilities(), []);
});

test('extension disable and unload serialize one close transition', async () => {
  const registry = new ExtensionRegistry();
  let closes = 0;
  registry.install({
    id: 'race.ext', origin: 'local-test', version: '1.0.0', license: 'Apache-2.0',
    host_contract_version: '1.0', capabilities: [], permissions: [],
    configuration_schema: {}, lifecycle: { shutdown_timeout_ms: 500 },
  }, () => ({ async close() { closes += 1; await new Promise((resolve) => setTimeout(resolve, 5)); } }));
  registry.enable('race.ext', 'enable:race.ext');
  const [disabled, unloaded] = await Promise.all([registry.disable('race.ext'), registry.unload('race.ext')]);
  assert.equal(disabled.state, 'disabled');
  assert.equal(unloaded, true);
  assert.equal(closes, 1);
  assert.deepEqual(registry.list(), []);
});

test('AC-PLUG-02 failed engine initialization still revokes active extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-extension-init-failure-'));
  const invalidHookRoot = join(root, 'not-a-directory');
  await writeFile(invalidHookRoot, 'fixture');
  const registry = new ExtensionRegistry();
  let cancelled = false;
  let closed = false;
  registry.install({
    id: 'owned.ext', origin: 'local-test', version: '1.0.0', license: 'Apache-2.0',
    host_contract_version: '1.0', capabilities: ['diagnostics'], permissions: [],
    configuration_schema: {}, lifecycle: { shutdown_timeout_ms: 500 },
  }, (host) => {
    host.signal.addEventListener('abort', () => { cancelled = true; });
    return { async close() { closed = true; } };
  });
  registry.enable('owned.ext', 'enable:owned.ext');
  const engine = new SessionEngine({
    config: base(root), extensionRegistry: registry, hookRoot: invalidHookRoot,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal', finishReason: 'stop' }; } }),
  });
  await assert.rejects(engine.initialize(), { code: 'ENOTDIR' });
  assert.equal(cancelled, true);
  assert.equal(closed, true);
  assert.equal(registry.inspect('owned.ext').state, 'disabled');
});
