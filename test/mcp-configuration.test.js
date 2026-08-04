// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { InteractiveWorkspace } from '../src/interactive-workspace.js';
import { mcpOverlay, overlayCommandDraft } from '../src/tui-overlays.js';

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
  assert.match(view.items[0].label, /\[on\]/u);
  assert.match(view.items[0].detail, /restart_required/u);
  assert.match(view.lines.join('\n'), /new conversations and after restart/u);
  const managed = mcpOverlay(view.items, { canManage: true });
  assert.deepEqual(managed.items.slice(-4).map((item) => item.id), [
    'action:add-http', 'action:add-stdio', 'action:test', 'action:delete',
  ]);
  assert.equal(overlayCommandDraft('mcp', 'action:add-http'), '/mcp add-http ');
});
