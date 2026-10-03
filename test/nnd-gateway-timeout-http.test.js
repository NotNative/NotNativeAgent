// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndGatewayTimeoutTransaction } from '../src/nnd-gateway-timeout-transaction.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';
import { Readable } from 'node:stream';

const base = '/v1/nnd/configuration/gateway';
const selected = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'gateway-http-test-token-with-32-characters';
const secret = 'PRIVATE_GATEWAY_TOKEN_123456';
async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-gateway-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'); await mkdir(config);
  const path = join(config, 'gateway.json');
  await writeFile(path, JSON.stringify({ version: 1, enabled: true, token: secret,
    authorized_user_ids: ['123'], polling_timeout_seconds: 25, private_future_field: 'PRIVATE_FUTURE' }));
  let permissions = ['nnd.configuration.read'];
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com', permissions }),
    nndGatewayTimeoutService: createNndGatewayTimeoutTransaction({ path,
      installationId: selected.installation_id, dataId: selected.data_id }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  async function call(suffix = '', { method = 'GET', body, bearer = token } = {}) {
    const response = await fetch(endpoint + base + suffix, { method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { path, call, permissions: value => { permissions = value; } };
}

test('native gateway HTTP projects only timeout and performs CAS with durable unapplied receipt', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('', { bearer: null })).status, 401);
  const read = await f.call();
  assert.equal(read.status, 200);
  assert.equal(read.body.polling_timeout_seconds, 25);
  assert.equal(read.body.application, 'not_applied');
  assert.equal(read.body.project_shadowed, false);
  const catalog = await f.call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map(field => field.path), ['polling_timeout_seconds']);
  const input = { ...selected, expected_revision: read.body.source_revision,
    expected_resolution_revision: read.body.resolution_revision, polling_timeout_seconds: 30 };
  assert.equal((await f.call('/save', { method: 'POST', body: input })).status, 403);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const preview = await f.call('/preview', { method: 'POST', body: input });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.view.polling_timeout_seconds, 30);
  const saved = await f.call('/save', { method: 'POST', body: { ...input, operation_id: 'set_timeout' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.persistence, 'saved');
  assert.equal(saved.body.application, 'not_applied');
  assert.equal(saved.body.next_action, 'restart_gateway');
  const operation = await f.call('/operations/set_timeout');
  assert.equal(operation.status, 200);
  assert.equal(operation.body.persisted_revision, saved.body.persisted_revision);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.polling_timeout_seconds, 30);
  assert.equal(stored.token, secret);
  assert.deepEqual(stored.authorized_user_ids, ['123']);
  assert.equal(stored.enabled, true);
  assert.equal(stored.private_future_field, 'PRIVATE_FUTURE');
  for (const result of [read, catalog, preview, saved, operation]) {
    assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE_FUTURE'), false);
  }
  const stale = await f.call('/save', { method: 'POST', body: { ...input, operation_id: 'stale_save' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'manifest_revision_conflict');
  assert.equal((await f.call('/operations/stale_save')).status, 404);
});

test('gateway HTTP refuses foreign identity, malformed values, query, and methods without source mutation', async t => {
  const f = await fixture(t);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const read = await f.call();
  const input = { ...selected, expected_revision: read.body.source_revision,
    expected_resolution_revision: read.body.resolution_revision, polling_timeout_seconds: 31 };
  const before = await readFile(f.path);
  for (const body of [{ ...input, data_id: 'foreign' }, { ...input, polling_timeout_seconds: 51 },
    { ...input, token: secret }, { ...input, expected_resolution_revision: 'a'.repeat(64) }]) {
    const result = await f.call('/preview', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'nnd_gateway_timeout_request_invalid');
  }
  assert.equal((await f.call('/preview', { method: 'GET' })).status, 405);
  assert.equal((await f.call('?token=1')).status, 400);
  assert.equal((await f.call('/operations/unknown')).status, 404);
  assert.deepEqual(await readFile(f.path), before);
});

test('gateway route projector ignores private fields even when service returns them', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  const baseView = { ...selected, source_revision: 'a'.repeat(64), resolution_revision: 'a'.repeat(64),
    project_shadowed: false, polling_timeout_seconds: 25, application: 'not_applied' };
  await dispatchNndConfigurationRequest(request, response, { url: new URL(base, 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndGatewayTimeoutService: { preview() {}, save() {}, operation() {}, read: () => ({ ...baseView, token: secret,
      authorized_user_ids: ['123'], private_future_field: 'PRIVATE_FUTURE' }) } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'source_state', 'source_revision', 'resolution_revision', 'project_shadowed',
    'polling_timeout_seconds', 'application']);
  assert.equal(JSON.stringify(response.body).includes('PRIVATE'), false);
});

test('gateway catalog is unavailable without the complete native transaction service', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await assert.rejects(dispatchNndConfigurationRequest(request, response, {
    url: new URL(base + '/catalog', 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndConfigurationService: {},
  }), { code: 'nnd_configuration_unavailable' });
});
