// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopEngineHost } from '../src/desktop-engine-host.js';
import { createDesktopWorkspaceBindingResolver } from '../src/desktop-workspace-selection.js';
import { primaryDesktopWorkspaceBinding } from '../src/desktop-workspace-binding.js';
import { readCanonicalGrant } from '../src/desktop-workspace-grants.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createDesktopLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

test('selected admitted root binds engine, catalog and replay; revocation blocks work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primaryRoot = join(root, 'primary'), selectedRoot = join(root, 'selected');
  await Promise.all([mkdir(primaryRoot), mkdir(selectedRoot)]);
  const primary = await primaryDesktopWorkspaceBinding(primaryRoot);
  const selected = await readCanonicalGrant(selectedRoot);
  let admitted = [selected];
  const service = { inventory: async () => ({ attached: primary, admitted }) };
  const resolver = createDesktopWorkspaceBindingResolver(primaryRoot, service);
  const catalogPath = join(root, 'catalog.json');
  const principal = { subjectId: 'operator', workspaceIds: [primary.id, selected.id] };
  let turnPrincipal;
  const createHost = () => new DesktopEngineHost({ catalogPath, primaryWorkspaceBinding: resolver,
    createEngine: async input => ({ config: { workspaceRoot: input.workspaceBinding.configured_root, attachments: { enabled: true, maxBytes: 1000 } },
      async initialize() {}, async shutdown() {},
      async submit(_command, actor) { turnPrincipal = actor; return { accepted: true }; } }) });
  const first = createHost();
  const context = await first.create('session_selected', principal,
    { workspace_id: selected.id, directory: selectedRoot });
  assert.equal(context.engine.config.workspaceRoot, selectedRoot);
  await first.submit('session_selected', { version: '1.0', type: 'submit', request_id: 'selected-turn', content: 'read' }, principal);
  assert.deepEqual(turnPrincipal.workspaceIds, [selected.id]);
  assert.equal(first.get('session_selected', principal).projectID, selected.id);
  await assert.rejects(first.withWorkspaceRevocation(selectedRoot, async () => {}),
    { code: 'desktop_workspace_in_use' });
  await first.create('session_primary', principal, { directory: primaryRoot });
  assert.deepEqual(JSON.parse(await readFile(catalogPath, 'utf8'))[0].workspaceIds, [selected.id]);
  await first.shutdown();
  const restored = createHost();
  await restored.initialize();
  assert.equal(restored.get('session_selected', principal).directory, selectedRoot);
  admitted = [];
  await assert.rejects(restored.assertWorkspaceBound('session_selected', principal),
    { code: 'desktop_workspace_binding_invalid' });
  await restored.shutdown();
  const recovered = createHost();
  await recovered.initialize();
  assert.equal(recovered.get('session_primary', principal).projectID, primary.id);
  assert.throws(() => recovered.get('session_selected', principal), { code: 'desktop_session_unavailable' });
  await assert.rejects(recovered.withWorkspaceRevocation(selectedRoot, async () => {}),
    { code: 'desktop_workspace_in_use' });
  await recovered.rename('session_primary', principal, 'still usable');
  assert.equal(JSON.parse(await readFile(catalogPath, 'utf8')).length, 2);
  await recovered.shutdown();
});

test('native session HTTP selects only an admitted identity and projects both roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primaryRoot = join(root, 'primary'), selectedRoot = join(root, 'selected');
  await Promise.all([mkdir(primaryRoot), mkdir(selectedRoot)]);
  const primary = await primaryDesktopWorkspaceBinding(primaryRoot);
  const selected = await readCanonicalGrant(selectedRoot);
  let broken = false;
  const service = { inventory: async () => {
    if (broken) throw new ContractError('desktop_workspace_admission_identity_mismatch', 'admitted root is missing');
    return { attached: primary, admitted: [selected] };
  } };
  let localOperator = true;
  const host = new DesktopEngineHost({ primaryWorkspaceBinding: createDesktopWorkspaceBindingResolver(primaryRoot, service),
    createEngine: async input => ({ config: { workspaceRoot: input.workspaceBinding.configured_root, attachments: { enabled: true, maxBytes: 1000 } },
      async initialize() {}, async shutdown() {} }) });
  const server = await startIntegrationServer({ activation: createDesktopLocalIntegrationActivation(),
    token: 'workspace-selection-http-token-36-characters', port: 0,
    desktopEngineHost: host, desktopWorkspaceRoot: primaryRoot, desktopWorkspaceAdmissionService: service,
    resolvePrincipal: () => ({ subjectId: localOperator ? 'desktop-local-operator' : 'scoped-user',
      platformRole: 'operator', workspaceIds: [primary.id],
      permissions: ['desktop.workspace.read', 'desktop.workspace.manage', 'desktop.read', 'desktop.session.create', 'desktop.session.update', 'desktop.session.submit'] }) });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); await host.shutdown(); });
  const base = `http://127.0.0.1:${server.address.port}`;
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method,
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
  const reviewPath = `/v1/desktop/sessions/${created.value.id}/review-mode`;
  const mode = await call(reviewPath);
  assert.equal(mode.status, 200);
  const changed = await call(reviewPath, { mode: 'unattended', expected_revision: mode.value.revision }, 'PUT');
  assert.equal(changed.status, 200); assert.equal(changed.value.effective, 'unattended');
  const upload = await call(`/v1/desktop/sessions/${created.value.id}/attachments`, { upload_id: 'probe', filename: 'probe.txt', mime_type: 'text/plain', data_url: 'data:text/plain;base64,aGVsbG8=' });
  assert.equal(upload.status, 201); assert.equal(upload.value.upload_id, 'probe');
  localOperator = false;
  assert.notEqual((await call(reviewPath)).status, 200);
  assert.equal((await call(`/v1/desktop/sessions/${created.value.id}/attachments`, { name: 'probe.txt' })).value.error.code, 'desktop_session_unavailable');
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
