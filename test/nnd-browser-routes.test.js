// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNndBrowserActionsService, projectReceipt } from '../src/nnd-browser-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

const base = '/v1/nnd/configuration/browser';
const identity = { installation_id: 'install_browser', data_id: 'data_browser' };
const token = 'browser-http-token-32-characters-long-test';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };

const ok = () => ({ available: true, version: '1.61.1', root: 'C:\\nna\\managed\\playwright',
  browser: 'chromium', browserPath: 'C:\\nna\\managed\\playwright\\browsers\\chromium.exe' });
const absent = () => ({ available: false, version: null, root: 'C:\\nna\\managed\\playwright',
  browser: 'chromium', browserPath: null, reason: 'not_installed' });

const runner = (value) => async () => value;
const service = (value) => createNndBrowserActionsService({ root: 'C:\\nna\\managed\\playwright',
  installationId: identity.installation_id, dataId: identity.data_id, statusRunner: runner(value) });

test('browser actions reuse the playwright authority verbatim and project one receipt grammar', async () => {
  const status = await service(ok()).status();
  assert.equal(status.action, 'status');
  assert.equal(status.application, 'not_applied');
  assert.deepEqual(Object.keys(status).sort(), ['action', 'application', 'data_id',
    'installation_id', 'operation_id', 'schema_version', 'scope', 'status']);
  const verify = await service(ok()).verify();
  assert.equal(verify.action, 'verify');
  assert.notEqual(verify.operation_id, status.operation_id);
  for (const receipt of [status, verify]) {
    const projected = projectReceipt(receipt);
    assert.deepEqual(projected.status, { available: true, version: '1.61.1', browser: 'chromium',
      browser_path: 'C:\\nna\\managed\\playwright\\browsers\\chromium.exe',
      root: 'C:\\nna\\managed\\playwright', reason: null });
  }
  const refusal = projectReceipt(await service(absent()).verify());
  assert.equal(refusal.status.available, false);
  assert.equal(refusal.status.reason, 'not_installed');
  assert.equal(refusal.status.version, null);
  for (const drift of [null, { ...ok() },
    { ...(await service(ok()).status()), status: { ...ok(), reason: 'surprise' } },
    { ...(await service(absent()).status()), status: { ...absent(), version: '1.0.0' } },
    { ...(await service(absent()).status()), status: { ...absent(), reason: 'exploded' } }]) {
    assert.throws(() => projectReceipt(drift), (error) => error.code === 'nnd_browser_projection_invalid');
  }
  assert.throws(() => createNndBrowserActionsService({ root: '', installationId: identity.installation_id,
    dataId: identity.data_id }), { code: 'nnd_browser_action_invalid' });
});

async function httpFixture(t, value, verifyValue = value) {
  const impl = createNndBrowserActionsService({ root: 'C:\\nna\\managed\\playwright',
    installationId: identity.installation_id, dataId: identity.data_id,
    statusRunner: async (root, options) => (options?.verifyLaunch ? verifyValue : value) });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndBrowserActionsService: impl });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', body, bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: bearer ? `Bearer ${bearer}` : '',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

test('browser HTTP serves the read receipt, the verify action, and the permission/grammar gates', async t => {
  const call = await httpFixture(t, ok());
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.action, 'status');
  assert.deepEqual(read.body.status, { available: true, version: '1.61.1', browser: 'chromium',
    browser_path: 'C:\\nna\\managed\\playwright\\browsers\\chromium.exe',
    root: 'C:\\nna\\managed\\playwright', reason: null });
  assert.equal((await call('', { method: 'POST', body: {} })).status, 405, 'status stays GET-only');
  assert.equal((await call('/unknown')).status, 404);
  const verified = await call('/actions/verify', { method: 'POST', body: {} });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.action, 'verify');
  const catalog = await call('/catalog');
  assert.deepEqual(catalog.body.fields.map((field) => field.path), ['available', 'version', 'verify']);
});

test('browser HTTP honours the verify refusal and the projector drift', async t => {
  const call = await httpFixture(t, absent(), { ...absent(), reason: 'validation_failed' });
  const verified = await call('/actions/verify', { method: 'POST', body: {} });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status.available, false);
  assert.equal(verified.body.status.reason, 'validation_failed');
  assert.equal(verified.body.status.version, null);
  const drifted = await httpFixture(t, { ...absent(), version: '1.0.0' });
  assert.equal((await drifted()).status, 500, 'a shaped-but-impossible refusal is projector drift');
});
