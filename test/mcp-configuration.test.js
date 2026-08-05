// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { InteractiveWorkspace } from '../src/interactive-workspace.js';
import { mcpOverlay } from '../src/tui-overlays.js';
import {
  availableMcpId, beginMcpManagementSelection, handleMcpSetupAction,
} from '../src/tui-mcp-setup.js';
import { managedMcpCredentialReference } from '../src/mcp-credentials.js';

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
      if (method === 'tools/list') return { tools: [] };
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
  await workspace.editMcpServer('memory', {
    id: 'memory', transport: 'streamable_http', endpoint: 'http://127.0.0.1:8899/mcp',
  });
  assert.equal(workspace.mcpStatus()[0].endpoint, 'http://127.0.0.1:8899/mcp');
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

test('MCP management uses guided menus for add, edit, and authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-guided-'));
  const configPath = join(root, 'settings.json');
  const dataPaths = { mcpCredentials: join(root, 'mcp-credentials.json') };
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
  const reference = managedMcpCredentialReference('notnative-memory');
  const manifestText = await readFile(configPath, 'utf8');
  assert.match(manifestText, new RegExp(reference, 'u'));
  assert.doesNotMatch(manifestText, /private-token-value/u);
  assert.match(await readFile(dataPaths.mcpCredentials, 'utf8'), /private-token-value/u);
  assert.equal(process.env[reference], 'private-token-value');

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
  delete process.env[reference];
});

test('MCP names produce stable collision-safe identifiers', () => {
  assert.equal(availableMcpId('NotNative Memory'), 'notnative-memory');
  assert.equal(availableMcpId('NotNative Memory', ['notnative-memory']), 'notnative-memory-2');
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
