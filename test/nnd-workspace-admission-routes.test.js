// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchNndWorkspaceAdmissionRequest } from '../src/nnd-workspace-admission-routes.js';
import { createNndWorkspaceAdmissionService } from '../src/nnd-workspace-admission.js';
import { createNndWorkspaceGrantService } from '../src/nnd-workspace-grants.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

const token = 'admission-routes-http-token-36-chars-test';
const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };

async function dispatch(path, method, permissions, service, body, search) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  const url = new URL(search ? `${path}?${search}` : path, 'http://localhost');
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  const matched = await dispatchNndWorkspaceAdmissionRequest(request, response, { url,
    principal: { subjectId: 'operator', permissions }, nndWorkspaceAdmissionService: service,
    nndEngineHost: { withWorkspaceRevocation: async (_, action) => action() } });
  return { matched, status: response.statusCode, body: response.body };
}

const body = (root, operationId = 'adm_1') => ({ installation_id: 'i', data_id: 'd',
  expected_revision: 'absent', operation_id: operationId, root });

test('admission routes authorize first, keep the grammar exact, and separate receipts', async () => {
  let reads = 0, mutations = 0;
  const service = { inventory: () => { reads++; return { selection_enabled: true, admitted: [{ root: 'C:/w' }], unavailable: [] }; },
    admit: () => { mutations++; return { persistence: 'saved' }; },
    revoke: () => { mutations++; return { persistence: 'saved', revoked_root: 'x' }; },
    operation: (_, id) => ({ operation_id: id }) };
  await assert.rejects(dispatch('/v1/nnd/workspaces/admissions', 'GET', [], service),
    { code: 'integration_permission_denied' });
  await assert.rejects(dispatch('/v1/nnd/workspaces/admissions', 'POST', ['nnd.workspace.read'], service, body('C:/w')),
    { code: 'integration_permission_denied' });
  assert.equal(reads + mutations, 0);
  const inventory = await dispatch('/v1/nnd/workspaces/admissions', 'GET', ['nnd.workspace.read'], service);
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.selection_enabled, true);
  await assert.rejects(dispatch('/v1/nnd/workspaces/admissions', 'GET', ['nnd.workspace.read'], service, undefined, 'root=x'),
    { code: 'nnd_workspace_admission_request_invalid' });
  for (const malformed of [{}, { ...body('C:/w'), extra: 1 },
    { ...body('C:/w'), expected_revision: 'nope' }, { ...body('C:/w'), operation_id: 'bad id!' },
    { ...body('C:/w'), root: 7 }]) {
    await assert.rejects(dispatch('/v1/nnd/workspaces/admissions', 'POST', ['nnd.workspace.manage'], service, malformed),
      { code: 'nnd_workspace_admission_request_invalid' });
  }
  assert.equal(mutations, 0);
  const admitted = await dispatch('/v1/nnd/workspaces/admissions', 'POST', ['nnd.workspace.manage'], service, body('C:/w'));
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.persistence, 'saved');
  const revoked = await dispatch('/v1/nnd/workspaces/admissions/revoke', 'POST', ['nnd.workspace.manage'], service, body('C:/w'));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked_root, 'x');
  const receipt = await dispatch('/v1/nnd/workspaces/admissions/operations/adm_1', 'GET', ['nnd.workspace.read'], service);
  assert.equal(receipt.body.operation_id, 'adm_1');
  assert.equal((await dispatch('/v1/nnd/workspaces/admissions', 'DELETE', ['nnd.workspace.manage'], service)).status, 405);
  assert.equal((await dispatch('/v1/nnd/workspaces/admissions/revoke', 'GET', ['nnd.workspace.read'], service)).status, 405);
  assert.equal((await dispatch('/v1/nnd/workspaces/admissions/operations/adm_1', 'POST', ['nnd.workspace.read'], service, body('C:/w'))).status, 405);
  assert.equal((await dispatch('/v1/nnd/workspaces/admissions/nothing', 'GET', ['nnd.workspace.read'], service)).status, 404);
  assert.equal((await dispatch('/v1/nnd/workspaces', 'GET', ['nnd.workspace.read'], service)).matched, false);
});

test('the admission family serves end-to-end over the integration server', async t => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-admissions-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), primary = join(root, 'primary'), alpha = join(root, 'alpha');
  await Promise.all([mkdir(config), mkdir(primary), mkdir(alpha)]);
  await writeFile(join(config, 'manifest.json'), JSON.stringify({ workspace_root: primary, provider,
    persistence: 'ephemeral' }));
  let guardBusy = false;
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    resolvePrincipal: () => ({ subjectId: 'operator', permissions: ['nnd.workspace.read', 'nnd.workspace.manage'] }),
    nndWorkspaceAdmissionService: createNndWorkspaceAdmissionService({ paths: { config },
      installationId: 'i', dataId: 'd' }),
    nndEngineHost: { withWorkspaceRevocation: async (_, action) => {
      if (guardBusy) throw new ContractError('nnd_workspace_in_use', 'Session still owns this workspace.');
      return action();
    } },
    nndWorkspaceGrantService: createNndWorkspaceGrantService({ paths: { config },
      installationId: 'i', dataId: 'd' }) });
  try {
    const base = `http://127.0.0.1:${server.address.port}/v1/nnd/workspaces/admissions`;
    const call = async (path, method = 'GET', payload, bearer = token) => {
      const response = await fetch(`${base}${path}`, { method,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        headers: { authorization: `Bearer ${bearer}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const payload = (root, operationId = 'adm_1', revision = 'absent') => ({ installation_id: 'i', data_id: 'd',
      expected_revision: revision, operation_id: operationId, root });
    const inventory = await call('');
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.selection_enabled, true);
    assert.deepEqual(inventory.body.admitted, []);
    const grants = await fetch(`http://127.0.0.1:${server.address.port}/v1/nnd/workspaces`,
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal(grants.status, 200);
    assert.equal((await grants.json()).primary.root, primary);
    const admitted = await call('', 'POST', payload(alpha));
    assert.equal(admitted.status, 200);
    assert.equal(admitted.body.persistence, 'saved');
    assert.equal(admitted.body.application, 'not_applied');
    const after = await call('');
    assert.equal(after.body.admitted.length, 1);
    assert.equal(after.body.admitted[0].root, alpha);
    const duplicate = await call('', 'POST', payload(alpha, 'adm_2', after.body.revision));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'nnd_workspace_admission_root_conflict');
    assert.equal((await call('', 'POST', '')).status, 400);
    const missing = await call('/revoke', 'POST', payload(join(root, 'never'), 'revoke_missing', after.body.revision));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'nnd_workspace_admission_target_missing');
    guardBusy = true;
    const busy = await call('/revoke', 'POST', payload(alpha, 'revoke_busy', after.body.revision));
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'nnd_workspace_in_use');
    guardBusy = false;
    const alphaAlias = process.platform === 'win32' ? alpha.toUpperCase() : alpha;
    const deleted = await call('/revoke', 'POST', payload(alphaAlias, 'revoke_alpha', after.body.revision));
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.revoked_root, alphaAlias);
    assert.equal((await call('/operations/adm_1', 'GET')).status, 200);
    assert.equal((await call('', 'GET', undefined, 'wrong-token')).status, 401);
    assert.equal((await call('', 'DELETE')).status, 405);
    assert.equal((await call('/nothing', 'GET')).status, 404);
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
