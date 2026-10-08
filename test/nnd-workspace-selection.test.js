// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { createNndWorkspaceBindingResolver } from '../src/nnd-workspace-selection.js';
import { primaryNndWorkspaceBinding } from '../src/nnd-workspace-binding.js';
import { readCanonicalGrant } from '../src/nnd-workspace-grants.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

test('selected admitted root binds engine, catalog and replay; revocation blocks work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primaryRoot = join(root, 'primary'), selectedRoot = join(root, 'selected');
  await Promise.all([mkdir(primaryRoot), mkdir(selectedRoot)]);
  const primary = await primaryNndWorkspaceBinding(primaryRoot);
  const selected = await readCanonicalGrant(selectedRoot);
  let admitted = [selected];
  const service = { inventory: async () => ({ attached: primary, admitted }) };
  const resolver = createNndWorkspaceBindingResolver(primaryRoot, service);
  const catalogPath = join(root, 'catalog.json');
  const principal = { subjectId: 'operator', workspaceIds: [primary.id, selected.id] };
  let turnPrincipal;
  const createHost = () => new NndEngineHost({ catalogPath, primaryWorkspaceBinding: resolver,
    createEngine: async input => ({ config: { workspaceRoot: input.workspaceBinding.configured_root },
      async initialize() {}, async shutdown() {},
      async submit(_command, actor) { turnPrincipal = actor; return { accepted: true }; } }) });
  const first = createHost();
  const context = await first.create('session_selected', principal,
    { workspace_id: selected.id, directory: selectedRoot });
  assert.equal(context.engine.config.workspaceRoot, selectedRoot);
  await first.submit('session_selected', { version: '1.0', type: 'submit', request_id: 'selected-turn', content: 'read' }, principal);
  assert.deepEqual(turnPrincipal.workspaceIds, [selected.id]);
  assert.equal(first.get('session_selected', principal).projectID, selected.id);
  await first.create('session_primary', principal, { directory: primaryRoot });
  assert.deepEqual(JSON.parse(await readFile(catalogPath, 'utf8'))[0].workspaceIds, [selected.id]);
  await first.shutdown();
  const restored = createHost();
  await restored.initialize();
  assert.equal(restored.get('session_selected', principal).directory, selectedRoot);
  admitted = [];
  await assert.rejects(restored.assertWorkspaceBound('session_selected', principal),
    { code: 'nnd_workspace_binding_invalid' });
  await restored.shutdown();
  const recovered = createHost();
  await recovered.initialize();
  assert.equal(recovered.get('session_primary', principal).projectID, primary.id);
  assert.throws(() => recovered.get('session_selected', principal), { code: 'nnd_session_unavailable' });
  await recovered.rename('session_primary', principal, 'still usable');
  assert.equal(JSON.parse(await readFile(catalogPath, 'utf8')).length, 2);
  await recovered.shutdown();
});

test('native session HTTP selects only an admitted identity and projects both roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primaryRoot = join(root, 'primary'), selectedRoot = join(root, 'selected');
  await Promise.all([mkdir(primaryRoot), mkdir(selectedRoot)]);
  const primary = await primaryNndWorkspaceBinding(primaryRoot);
  const selected = await readCanonicalGrant(selectedRoot);
  let broken = false;
  const service = { inventory: async () => {
    if (broken) throw new ContractError('nnd_workspace_admission_identity_mismatch', 'admitted root is missing');
    return { attached: primary, admitted: [selected] };
  } };
  let localOperator = true;
  const host = new NndEngineHost({ primaryWorkspaceBinding: createNndWorkspaceBindingResolver(primaryRoot, service),
    createEngine: async input => ({ config: { workspaceRoot: input.workspaceBinding.configured_root },
      async initialize() {}, async shutdown() {} }) });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token: 'workspace-selection-http-token-36-characters', port: 0,
    nndEngineHost: host, nndWorkspaceRoot: primaryRoot, nndWorkspaceAdmissionService: service,
    resolvePrincipal: () => ({ subjectId: localOperator ? 'nnd-local-operator' : 'scoped-user',
      platformRole: 'operator', workspaceIds: [primary.id],
      permissions: ['nnd.workspace.read', 'nnd.workspace.manage', 'nnd.read', 'nnd.session.create'] }) });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); await host.shutdown(); });
  const base = `http://127.0.0.1:${server.address.port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer workspace-selection-http-token-36-characters',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const projects = await call('/project');
  assert.deepEqual(projects.value.map(row => row.id), [primary.id, selected.id]);
  const created = await call('/session', { workspace_id: selected.id, directory: selectedRoot });
  assert.equal(created.status, 201);
  assert.equal(created.value.directory, selectedRoot);
  assert.equal(created.value.projectID, selected.id);
  localOperator = false;
  assert.deepEqual((await call('/project')).value.map(row => row.id), ['nna_workspace']);
  assert.notEqual((await call('/session', { workspace_id: selected.id, directory: selectedRoot })).status, 201);
  localOperator = true;
  const refused = await call('/session', { workspace_id: 'ws_' + '0'.repeat(24) });
  assert.notEqual(refused.status, 201);
  broken = true;
  const primaryStillAvailable = await call('/session', {});
  assert.equal(primaryStillAvailable.status, 201);
  assert.equal(primaryStillAvailable.value.projectID, primary.id);
});
