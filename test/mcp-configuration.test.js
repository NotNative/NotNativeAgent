// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { mcpOverlay } from '../src/tui/overlays.js';
import {
  availableMcpId, beginMcpManagementSelection, handleMcpSetupAction,
} from '../src/tui/mcp-setup.js';

function configuration(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'model', trust_zone: 'loopback' },
  });
}

test('Main manages durable MCP topology and marks it for new-session activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-config-'));
  const configPath = join(root, 'settings.json');
  const transportFactory = () => ({
    protocolVersion: '2026-07-28', async open() {}, async close() {},
    async request(method) {
      if (method === 'initialize') return { protocolVersion: '2026-07-28', capabilities: { tools: {} } };
      if (method === 'tools/list') return { tools: [{ name: 'memory.search', description: 'Search memory', inputSchema: { type: 'object', properties: {} } }] };
      throw new Error(`unexpected ${method}`);
    },
  });
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath, mcpTransportFactory: transportFactory,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const added = await workspace.addMcpServer({
    id: 'memory', transport: 'streamable_http', endpoint: 'http://127.0.0.1:7788/mcp',
    credentialEnv: 'NNM_MCP_TOKEN',
  });
  assert.equal(added.restartRequired, true);
  assert.equal(workspace.mcpStatus()[0].runtime, 'restart_required');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).mcp_servers[0].credential_env, 'NNM_MCP_TOKEN');
  const tested = await workspace.testMcpServer('memory');
  assert.equal(tested.status, 'ready');
  assert.deepEqual(tested.tools, ['mcp.memory.memory.search']);
  await workspace.editMcpServer('memory', {
    id: 'memory', transport: 'streamable_http', endpoint: 'http://127.0.0.1:8899/mcp',
  });
  assert.equal(workspace.mcpStatus()[0].endpoint, 'http://127.0.0.1:8899/mcp');
  assert.equal(workspace.mcpStatus()[0].credentialEnv, 'NNM_MCP_TOKEN');
  await workspace.setMcpEnabled('memory', false);
  assert.equal(workspace.mcpStatus()[0].enabled, false);
  await workspace.deleteMcpServer('memory');
  assert.deepEqual(workspace.mcpStatus(), []);
  await workspace.shutdown();
});

test('MCP overlay exposes configured state and explicit restart semantics', () => {
  const view = mcpOverlay([{
    id: 'memory', enabled: true, transport: 'streamable_http', endpoint: 'http://127.0.0.1/mcp', runtime: 'restart_required',
  }]);
  assert.equal(view.items[0].id, 'memory');
  assert.equal(view.items[0].label, 'memory');
  assert.equal(view.items[0].badge, 'enabled');
  assert.match(view.items[0].detail, /restart_required/u);
  assert.match(view.lines.join('\n'), /new conversations and after restart/u);
  assert.doesNotMatch(view.lines.join('\n'), /\/mcp add-http/u);
  const managed = mcpOverlay([{
    id: 'memory', enabled: true, transport: 'streamable_http', endpoint: 'http://127.0.0.1/mcp', runtime: 'restart_required',
  }], { canManage: true });
  assert.equal(managed.items.at(-1).id, 'action:add');
});

test('MCP connection testing fails truthfully when initialization cannot complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-test-failure-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    mcpTransportFactory: () => ({
      async open() { throw Object.assign(new Error('unavailable'), { code: 'mcp_unreachable', retryable: true }); },
      async close() {},
    }),
  });
  await workspace.create('Main', 'main');
  await workspace.addMcpServer({ id: 'offline', transport: 'streamable_http', endpoint: 'http://127.0.0.1:7788/mcp' });
  await assert.rejects(workspace.testMcpServer('offline'), { code: 'mcp_unreachable' });
  await workspace.shutdown();
});

test('MCP management uses guided menus for add, edit, and authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-guided-'));
  const configPath = join(root, 'settings.json');
  const dataPaths = {
    mcpCredentials: join(root, 'mcp-credentials.json'),
    secretVault: join(root, 'secrets.json'), secretKey: join(root, 'secret.key'), secretAudit: join(root, 'secret-audit.jsonl'),
  };
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath, dataPaths,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  workspace.projection.openOverlay(mcpOverlay([], { canManage: true }));
  assert.equal(beginMcpManagementSelection({ id: 'action:add' }, workspace, workspace.projection.overlay), true);
  assert.equal(workspace.projection.overlay.kind, 'mcp-transport');

  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-form');
  workspace.projection.overlay.editor.set('NotNative Memory');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.match(workspace.projection.overlay.lines.join('\n'), /http:\/\/<hostname>:<port>\/mcp/u);
  workspace.projection.overlay.editor.set('http://127.0.0.1:9500/mcp');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-auth');
  workspace.projection.moveOverlaySelection(1);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-form');
  workspace.projection.overlay.editor.set('private-token-value');
  await handleMcpSetupAction({ action: 'home' }, workspace);
  assert.doesNotMatch(workspace.projection.overlay.lines.join('\n'), /private-token-value/u);
  assert.match(workspace.projection.overlay.lines.join('\n'), /\*{8}/u);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.mcpStatus()[0].id, 'notnative-memory');
  assert.equal(workspace.projection.overlay.kind, 'mcp');
  const [secret] = await workspace.listSecrets();
  assert.equal(secret.label, 'NotNative Memory-MCP');
  assert.deepEqual(secret.fields, ['token']);
  const manifestText = await readFile(configPath, 'utf8');
  assert.match(manifestText, new RegExp(secret.id, 'u'));
  assert.doesNotMatch(manifestText, /private-token-value/u);
  assert.doesNotMatch(await readFile(dataPaths.secretVault, 'utf8'), /private-token-value/u);

  beginMcpManagementSelection(workspace.projection.overlay.items[0], workspace, workspace.projection.overlay);
  assert.equal(workspace.projection.overlay.kind, 'mcp-server');
  assert.deepEqual(workspace.projection.overlay.items.map((item) => item.id), ['test', 'disable', 'edit', 'delete']);
  workspace.projection.moveOverlaySelection(2);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('http://127.0.0.1:9600/mcp');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.mcpStatus()[0].endpoint, 'http://127.0.0.1:9600/mcp');
  await workspace.shutdown();
});

test('MCP names produce stable collision-safe identifiers', () => {
  assert.equal(availableMcpId('NotNative Memory'), 'notnative-memory');
  assert.equal(availableMcpId('NotNative Memory', ['notnative-memory']), 'notnative-memory-2');
});

test('MCP HTTP setup stores a new custom-header credential in the Secret Broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-header-'));
  const configPath = join(root, 'settings.json');
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath,
    dataPaths: {
      secretVault: join(root, 'secrets.json'), secretKey: join(root, 'secret.key'), secretAudit: join(root, 'secret-audit.jsonl'),
    },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  workspace.projection.openOverlay(mcpOverlay([], { canManage: true }));
  beginMcpManagementSelection({ id: 'action:add' }, workspace, workspace.projection.overlay);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('Header Service');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('http://127.0.0.1:9501/mcp');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.moveOverlaySelection(4);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('X-Service-Key');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('custom-header-secret');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  const [server] = workspace.mcpStatus();
  const [secret] = await workspace.listSecrets();
  assert.deepEqual(server.headerCredentials['X-Service-Key'], { source: 'secret', secretId: secret.id, field: 'token' });
  const manifestText = await readFile(configPath, 'utf8');
  assert.match(manifestText, /X-Service-Key/u);
  assert.doesNotMatch(manifestText, /custom-header-secret/u);
  await workspace.shutdown();
});

test('referenced secrets expose their consumers and cannot be deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-reference-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    dataPaths: {
      secretVault: join(root, 'secrets.json'), secretKey: join(root, 'secret.key'), secretAudit: join(root, 'secret-audit.jsonl'),
    },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const secret = await workspace.createSecret({ label: 'Bound MCP token', kind: 'token', fields: { token: 'private' } });
  await workspace.addMcpServer({
    id: 'bound', transport: 'streamable_http', endpoint: 'http://127.0.0.1:9502/mcp',
    credential: { source: 'secret', secretId: secret.id, field: 'token' },
  });
  const [listed] = await workspace.listSecrets();
  assert.deepEqual(listed.references, [{ kind: 'mcp', id: 'bound', label: 'MCP bound' }]);
  const renamed = await workspace.renameSecret(secret.id, 'Reusable service token');
  assert.equal(renamed.id, secret.id);
  assert.equal(renamed.label, 'Reusable service token');
  assert.equal(workspace.mcpStatus()[0].credential.secretId, secret.id);
  assert.deepEqual((await workspace.listSecrets())[0].references, [{ kind: 'mcp', id: 'bound', label: 'MCP bound' }]);
  assert.throws(() => workspace.deleteSecret(secret.id), { code: 'secret_in_use' });
  await workspace.shutdown();
});

test('MCP stdio setup parses a quoted launch command and keeps forms single-line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-stdio-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  workspace.projection.openOverlay(mcpOverlay([], { canManage: true }));
  beginMcpManagementSelection({ id: 'action:add' }, workspace, workspace.projection.overlay);
  workspace.projection.moveOverlaySelection(1);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  await handleMcpSetupAction({ action: 'paste', text: 'Local Files\r\nignored' }, workspace);
  assert.equal(workspace.projection.overlay.editor.text, 'Local Files');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set('node "server file.js" --safe');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  workspace.projection.overlay.editor.set(root);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-auth');
  await handleMcpSetupAction({ action: 'back' }, workspace);
  assert.match(workspace.projection.overlay.lines.join('\n'), /Working directory/u);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  const server = workspace.mcpStatus()[0];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['server file.js', '--safe']);
  assert.equal(server.cwd, root);
  await workspace.shutdown();
});
