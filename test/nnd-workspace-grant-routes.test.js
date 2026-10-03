// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { dispatchNndWorkspaceGrantRequest } from '../src/nnd-workspace-grant-routes.js';

async function dispatch(path, method, permissions, service, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  const matched = await dispatchNndWorkspaceGrantRequest(request, response, { url: new URL(path, 'http://localhost'),
    principal: { subjectId: 'operator', permissions }, nndWorkspaceGrantService: service });
  return { matched, status: response.statusCode, body: response.body };
}

test('workspace routes authorize before reading body and keep mutation separate', async () => {
  let calls = 0;
  const service = { read: () => { calls++; return { selection_enabled: false }; },
    save: () => { calls++; return { persistence: 'saved' }; }, operation: () => null };
  await assert.rejects(dispatch('/v1/nnd/workspaces', 'POST', ['nnd.workspace.read'], service, {}),
    { code: 'integration_permission_denied' });
  await assert.rejects(dispatch('/v1/nnd/workspaces', 'GET', [], service), { code: 'integration_permission_denied' });
  assert.equal(calls, 0);
  const read = await dispatch('/v1/nnd/workspaces', 'GET', ['nnd.workspace.read'], service);
  assert.equal(read.status, 200); assert.equal(read.body.selection_enabled, false);
  await assert.rejects(dispatch('/v1/nnd/workspaces?root=x', 'GET', ['nnd.workspace.read'], service),
    { code: 'nnd_workspace_grant_request_invalid' });
});

test('workspace route rejects malformed mutation and resolves scoped operations', async () => {
  const service = { read: () => ({}), save: () => ({ persistence: 'saved' }), operation: (_, id) => ({ operation_id: id }) };
  for (const body of [{}, { installation_id: 'a', data_id: 'b', expected_revision: 'absent', operation_id: 'a', secondary_root: null, workspace_ids: [] }]) {
    await assert.rejects(dispatch('/v1/nnd/workspaces', 'POST', ['nnd.workspace.manage'], service, body),
      { code: 'nnd_workspace_grant_request_invalid' });
  }
  const operation = await dispatch('/v1/nnd/workspaces/operations/save_1', 'GET', ['nnd.workspace.read'], service);
  assert.equal(operation.body.operation_id, 'save_1');
  assert.equal((await dispatch('/v1/nnd/workspaces/operations/save_1', 'POST', ['nnd.workspace.read'], service)).status, 405);
});
