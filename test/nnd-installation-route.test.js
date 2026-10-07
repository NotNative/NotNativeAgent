// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/ids.js';
import { createNndInstallationSnapshot, OBSERVED_DESCRIPTOR } from '../src/nnd-installation-snapshot.js';
import { dispatchNndInstallationRequest } from '../src/nnd-installation-route.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const base = '/v1/nnd/configuration/installation';
const selected = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'installation-http-test-token-32-characters-lng';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const LIMITED = { subjectId: 'limited@example.com', permissions: ['nnd.configuration.manage'] };

const verified = (over = {}) => ({
  product: 'NotNativeAgent', version: '20261006-3', install_root: 'C:\\Program Files\\NotNativeAgent',
  data_root: 'C:\\Users\\operator\\AppData\\Roaming\\NotNativeAgent', node: 'C:\\runtime\\node.exe',
  node_major: 24, ...over });
const reader = async () => verified();

const snapshot = (over = {}) => createNndInstallationSnapshot({
  installRoot: 'C:\\Program Files\\NotNativeAgent', installationId: selected.installation_id,
  dataId: selected.data_id, readIdentity: reader, ...over });

test('installation snapshot re-verifies through the authority and projects the descriptor', async () => {
  const value = await snapshot().read(PERMITTED);
  assert.deepEqual(Object.keys(value), ['schema_version', 'installation_id', 'data_id', 'scope',
    'product', 'version', 'install_root', 'data_root', 'node', 'node_major']);
  assert.equal(value.product, 'NotNativeAgent');
  assert.equal(value.version, '20261006-3');
  assert.equal(value.node_major, 24);
  assert.deepEqual(OBSERVED_DESCRIPTOR, ['product', 'version', 'install_root', 'data_root',
    'node', 'node_major']);
  const refused = snapshot({ readIdentity: async () => { throw new ContractError('nnd_install_descriptor_unavailable', 'missing'); } });
  await assert.rejects(refused.read(PERMITTED), { code: 'nnd_install_descriptor_unavailable' },
    'an authority ContractError passes verbatim');
  const custom = snapshot({ readIdentity: async () => { throw new ContractError('nnd_install_runtime_invalid', 'probe failed'); } });
  await assert.rejects(custom.read(PERMITTED), { code: 'nnd_install_runtime_invalid' },
    'ContractError codes from the authority pass verbatim');
});

test('installation snapshot refuses a bad factory identity and a lesser principal', async () => {
  assert.throws(() => createNndInstallationSnapshot({ installRoot: '', installationId: selected.installation_id,
    dataId: selected.data_id, readIdentity: reader }), { code: 'nnd_installation_request_invalid' });
  assert.throws(() => createNndInstallationSnapshot({ installRoot: 'C:\\x', installationId: 'bad id',
    dataId: selected.data_id, readIdentity: reader }), { code: 'nnd_installation_request_invalid' });
  await assert.rejects(snapshot().read(LIMITED), (error) => error.code !== 'nnd_installation_request_invalid',
    'the permission check runs before any descriptor work');
});

async function httpFixture(t, readIdentity = reader) {
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED,
    nndInstallationSnapshotService: snapshot({ readIdentity }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix,
      { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() };
  };
}

test('installation HTTP projects the descriptor and catalog read-only and honours the permission', async t => {
  const call = await httpFixture(t);
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(read.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'product', 'version', 'install_root', 'data_root', 'node', 'node_major']);
  assert.equal((await call('', { method: 'POST', bearer: token })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), OBSERVED_DESCRIPTOR);
  for (const field of catalog.body.fields) {
    assert.equal(field.classification, 'generated_state');
    assert.deepEqual(field.editability, { available: false, scope: 'user', reason: 'installer_state' });
  }
});

test('installation HTTP honours the descriptor drift status and the grammar is transport-honest', async t => {
  const call = await httpFixture(t, async () => { throw new ContractError('nnd_install_descriptor_unavailable', 'missing'); });
  const read = await call();
  assert.equal(read.status, 503, 'the descriptor authority speaks for the disk as a 503');
  assert.equal(read.body.error.code, 'nnd_install_descriptor_unavailable');
  const projected = await httpFixture(t, async () => verified({ version: 'not-a-version' }));
  const drifted = await projected();
  assert.equal(drifted.status, 500, 'a value the router cannot accept is projector drift');
  assert.equal(drifted.body.error.code, 'nnd_installation_projection_invalid');
});
