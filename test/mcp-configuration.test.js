// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { cleanupUnreferencedMcpCredential, isMcpCredentialCleanupPending, withMcpCredentialMutation } from '../src/experience/mcp.js';
import { saveManagedMcpCredential } from '../src/mcp-credentials.js';
import { mcpOverlay } from '../src/tui/overlays.js';
import { handleMcpCommand } from '../src/tui/mcp-command.js';
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
  const root = createScratchSync('nna-mcp-config-');
  const configPath = join(root, 'settings.json');
  const transportFactory = () => ({
    protocolVersion: '2026-07-28', async open() {}, async close() {},
    async request(method) {
      if (method === 'initialize') return { protocolVersion: '2026-07-28', capabilities: { tools: {} } };
      if (method === 'tools/list') return { tools: [{ name: 'memory.search', description: 'Search memory', inputSchema: { type: 'object', properties: {} } }] };
      throw new Error(`unexpected ${method}`);
    },
  });
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
  assert.deepEqual(tested.tools, ['mcp_memory_memory_search']);
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

test('MCP deletion retains a credential and explicit cleanup remains retryable after a store failure', async () => {
  const root = createScratchSync('nna-mcp-delete-retry-');
  const credentialPath = join(root, 'mcp-credentials.json');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
    config: configuration(root), configPath: join(root, 'settings.json'),
    dataPaths: { mcpCredentials: credentialPath },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const reference = await workspace.saveMcpCredential('memory', 'private-token');
  await workspace.addMcpServer({ id: 'memory', transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', credentialEnv: reference });
  const result = await workspace.deleteMcpServer('memory');
  assert.deepEqual(workspace.config.mcpServers, []);
  assert.equal(result.credentialCleanup.status, 'retained');
  assert.deepEqual(result.credentialCleanup.references, [reference]);
  assert.match(await readFile(credentialPath, 'utf8'), /private-token/u);
  await handleMcpCommand('credentials', workspace);
  assert.match(workspace.projection.overlay.lines.join('\n'), new RegExp(reference, 'u'));
  assert.doesNotMatch(workspace.projection.overlay.lines.join('\n'), /private-token/u);
  await assert.rejects(handleMcpCommand(`cleanup-credential ${reference}`, workspace), { code: 'mcp_command_invalid' });
  const backup = `${credentialPath}.backup`;
  await rename(credentialPath, backup);
  await mkdir(credentialPath);
  await assert.rejects(handleMcpCommand(`cleanup-credential ${reference} --confirm-unshared`, workspace));
  await rm(credentialPath, { recursive: true });
  await rename(backup, credentialPath);
  await handleMcpCommand(`cleanup-credential ${reference} --confirm-unshared`, workspace);
  assert.match(workspace.projection.overlay.lines.join('\n'), /credential .* removed/u);
  assert.doesNotMatch(await readFile(credentialPath, 'utf8'), /private-token/u);
  await workspace.shutdown();
});

test('MCP deletion retains a managed credential while another server uses it', async () => {
  const root = createScratchSync('nna-mcp-shared-');
  const credentialPath = join(root, 'mcp-credentials.json');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
    config: configuration(root), configPath: join(root, 'settings.json'),
    dataPaths: { mcpCredentials: credentialPath },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const reference = await workspace.saveMcpCredential('shared', 'private-token');
  for (const id of ['first', 'second']) await workspace.addMcpServer({ id, transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', credentialEnv: reference });
  await workspace.deleteMcpServer('first');
  assert.match(await readFile(credentialPath, 'utf8'), /private-token/u);
  await assert.rejects(workspace.removeMcpCredential(reference), { code: 'mcp_credential_confirmation_required' });
  await assert.rejects(workspace.removeMcpCredential(reference, true), { code: 'mcp_credential_in_use' });
  const result = await workspace.deleteMcpServer('second');
  assert.equal(result.credentialCleanup.status, 'retained');
  assert.match(await readFile(credentialPath, 'utf8'), /private-token/u);
  await workspace.addMcpServer({ id: 'header', transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', headerEnv: { 'X-Token': reference } });
  await assert.rejects(workspace.removeMcpCredential(reference, true), { code: 'mcp_credential_in_use' });
  workspace.projection.openOverlay(mcpOverlay(workspace.mcpStatus(), { canManage: true }));
  assert.equal(beginMcpManagementSelection({ id: 'header' }, workspace, workspace.projection.overlay), true);
  workspace.projection.moveOverlaySelection(3);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-delete-confirm');
  workspace.projection.moveOverlaySelection(1);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp');
  assert.match(workspace.projection.overlay.lines.join('\n'), new RegExp(reference, 'u'));
  assert.match(workspace.projection.overlay.lines.join('\n'), /\/mcp credentials/u);
  await handleMcpCommand(`cleanup-credential ${reference} --confirm-unshared`, workspace);
  assert.doesNotMatch(await readFile(credentialPath, 'utf8'), /private-token/u);
  await workspace.shutdown();
});

test('managed MCP credential cleanup waits for conversations using the old configuration', async () => {
  const root = createScratchSync('nna-mcp-active-credential-');
  const credentialPath = join(root, 'mcp-credentials.json');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
    config: configuration(root), configPath: join(root, 'settings.json'),
    dataPaths: { mcpCredentials: credentialPath },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    mcpTransportFactory: () => ({
      async open() {}, async close() {},
      async request(method) {
        if (method === 'initialize') return { protocolVersion: '2026-07-28', capabilities: { tools: {} } };
        if (method === 'tools/list') return { tools: [] };
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  await workspace.create('Main', 'main');
  const reference = await workspace.saveMcpCredential('memory', 'private-token');
  await workspace.addMcpServer({ id: 'memory', transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', credentialEnv: reference });
  await workspace.create('Second', 'second');
  workspace.switch('main');
  await workspace.deleteMcpServer('memory');
  await assert.rejects(workspace.removeMcpCredential(reference, true), { code: 'mcp_credential_in_use' });
  assert.match(await readFile(credentialPath, 'utf8'), /private-token/u);
  workspace.switch('second');
  await workspace.closeActive();
  workspace.switch('main');
  await workspace.removeMcpCredential(reference, true);
  assert.doesNotMatch(await readFile(credentialPath, 'utf8'), /private-token/u);
  await workspace.shutdown();
});

test('MCP credential cleanup fences conversations that are still being created', async () => {
  const root = createScratchSync('nna-mcp-creating-credential-');
  const dataPaths = { mcpCredentials: join(root, 'mcp-credentials.json') };
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
    config: configuration(root), configPath: join(root, 'settings.json'), dataPaths,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const reference = await saveManagedMcpCredential(dataPaths, 'memory', 'private-token');
  const first = Promise.withResolvers();
  const firstCleanup = cleanupUnreferencedMcpCredential(workspace, reference, true, new Map([['creating', first.promise]]));
  assert.equal(isMcpCredentialCleanupPending(workspace), true);
  await assert.rejects(workspace.create('Second', 'second'), { code: 'mcp_credentials_busy' });
  await assert.rejects(workspace.addMcpServer({ id: 'new', transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', credentialEnv: reference }), { code: 'mcp_credentials_busy' });
  await assert.rejects(workspace.saveMcpCredential('new', 'another-token'), { code: 'mcp_credentials_busy' });
  workspace.sessions.set('creating', { engine: { mcp: { configs: [{ credentialEnv: reference }] } } });
  first.resolve();
  await assert.rejects(firstCleanup, { code: 'mcp_credential_in_use' });
  assert.equal(isMcpCredentialCleanupPending(workspace), false);
  assert.match(await readFile(dataPaths.mcpCredentials, 'utf8'), /private-token/u);
  workspace.sessions.delete('creating');
  const second = Promise.withResolvers();
  const secondCleanup = cleanupUnreferencedMcpCredential(workspace, reference, true, new Map([['creating', second.promise]]));
  await assert.rejects(cleanupUnreferencedMcpCredential(workspace, reference, true, new Map()), { code: 'mcp_credentials_busy' });
  second.resolve();
  assert.equal(await secondCleanup, true);
  assert.doesNotMatch(await readFile(dataPaths.mcpCredentials, 'utf8'), /private-token/u);
  const inFlight = Promise.withResolvers();
  const mutation = withMcpCredentialMutation(workspace, () => inFlight.promise);
  await assert.rejects(cleanupUnreferencedMcpCredential(workspace, reference, true, new Map()), { code: 'mcp_credentials_busy' });
  inFlight.resolve();
  await mutation;
  await workspace.shutdown();
});

test('guided MCP edit retains the old managed credential after changing authentication', async () => {
  const root = createScratchSync('nna-mcp-edit-credential-');
  const credentialPath = join(root, 'mcp-credentials.json');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
    config: configuration(root), configPath: join(root, 'settings.json'),
    dataPaths: { mcpCredentials: credentialPath },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const reference = await workspace.saveMcpCredential('shared', 'private-token');
  for (const id of ['first', 'second']) await workspace.addMcpServer({ id, transport: 'streamable_http',
    endpoint: 'http://127.0.0.1:7788/mcp', credentialEnv: reference });
  workspace.projection.openOverlay(mcpOverlay(workspace.mcpStatus(), { canManage: true }));
  assert.equal(beginMcpManagementSelection({ id: 'first' }, workspace, workspace.projection.overlay), true);
  workspace.projection.moveOverlaySelection(2);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-form');
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp-auth');
  workspace.projection.moveOverlaySelection(1);
  await handleMcpSetupAction({ action: 'submit' }, workspace);
  assert.equal(workspace.projection.overlay.kind, 'mcp');
  assert.equal(workspace.mcpStatus().find((server) => server.id === 'first').credentialEnv, undefined);
  assert.equal(workspace.mcpStatus().find((server) => server.id === 'second').credentialEnv, reference);
  assert.match(await readFile(credentialPath, 'utf8'), /private-token/u);
  assert.match(workspace.projection.overlay.lines.join('\n'), /Previous managed credential.*remains in the user store/u);
  assert.match(workspace.projection.overlay.lines.join('\n'), /--confirm-unshared/u);
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
  const root = createScratchSync('nna-mcp-test-failure-');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
  const root = createScratchSync('nna-mcp-guided-');
  const configPath = join(root, 'settings.json');
  const dataPaths = {
    mcpCredentials: join(root, 'mcp-credentials.json'),
    secretVault: join(root, 'secrets.json'), secretKey: join(root, 'secret.key'), secretAudit: join(root, 'secret-audit.jsonl'),
  };
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
  const root = createScratchSync('nna-mcp-header-');
  const configPath = join(root, 'settings.json');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
  const root = createScratchSync('nna-secret-reference-');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
  const root = createScratchSync('nna-mcp-stdio-');
  const workspace = new InteractiveWorkspace({ initializeManifest: true,
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
