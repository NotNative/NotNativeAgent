// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createNndEnvironmentSnapshot } from '../src/nnd-environment-snapshot.js';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const base = '/v1/nnd/configuration/environment';
const selected = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'environment-http-test-token-32-characters-long';
const NAMES = ['NNA_HOME', 'NNA_PROVIDER_ENDPOINT', 'NNA_MODEL', 'NNA_REDUCED_MOTION', 'NO_COLOR',
  'NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'];
const SECRETS = new Set(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD']);
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };

const snapshot = (environment) => createNndEnvironmentSnapshot({ environment: environment ?? {
  NNA_HOME: 'C:\\nna', NNA_PROVIDER_ENDPOINT: 'https://relay.example/v1', NNA_MODEL: 'demo-model',
  NNA_REDUCED_MOTION: '1', NO_COLOR: '', NNA_TELEGRAM_BOT_TOKEN: '(value not projected)',
  OPENCODE_SERVER_PASSWORD: 'secret-value' },
  installationId: selected.installation_id, dataId: selected.data_id });

test('environment snapshot projects the seven census names with secret redaction', async () => {
  const value = await snapshot().read(PERMITTED);
  assert.deepEqual(Object.keys(value), ['installation_id', 'data_id', 'scope', 'schema_version',
    'observation_digest', 'observed', 'environment_scope']);
  assert.deepEqual(value.observed.map((entry) => entry.name), NAMES);
  assert.equal(value.environment_scope, 'service_process');
  for (const entry of value.observed) {
    if (SECRETS.has(entry.name)) assert.deepEqual([entry.secret, entry.value, entry.present],
      [true, null, true], 'credential entries never project a value');
    else assert.equal(typeof entry.value, 'string', `${entry.name} projects its value`);
  }
  assert.deepEqual(Object.keys(value.observed[4]), ['name', 'secret', 'present', 'value']);
  assert.equal(value.observed[4].value, '', 'an empty value is a legal observed value');
  const stable = await snapshot().read(PERMITTED);
  assert.equal(stable.observation_digest, value.observation_digest);
  const changed = await snapshot({ ...snapshotArgs(), NNA_MODEL: 'other' }).read(PERMITTED);
  assert.notEqual(changed.observation_digest, value.observation_digest);
  function snapshotArgs() { return { NNA_HOME: 'C:\\nna', NNA_PROVIDER_ENDPOINT: 'https://relay.example/v1',
    NNA_REDUCED_MOTION: '1', NO_COLOR: '' }; }
});

test('environment snapshot refuses a bad identity, hostile environment, and oversize values', async () => {
  assert.throws(() => createNndEnvironmentSnapshot({ environment: {}, installationId: 'bad id', dataId: 'data_test' }),
    { code: 'nnd_environment_request_invalid' });
  assert.throws(() => createNndEnvironmentSnapshot({ environment: [], installationId: 'install_test', dataId: 'data_test' }),
    { code: 'nnd_environment_request_invalid' });
  await assert.rejects(snapshot({ NNA_MODEL: 'x'.repeat(17000) }).read(PERMITTED),
    { code: 'nnd_environment_value_too_large' });
  await assert.rejects(snapshot().read({ subjectId: 'limited', permissions: ['nnd.configuration.manage'] }),
    (error) => error.code !== 'nnd_environment_request_invalid');
});

async function httpFixture(t, environment) {
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndEnvironmentSnapshotService: snapshot(environment) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix,
      { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() };
  };
}

test('environment HTTP projects the observation and catalog with read-only editability', async t => {
  const call = await httpFixture(t);
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.observed.map((entry) => entry.name), NAMES);
  assert.equal(JSON.stringify(read.body).includes('value not projected'), false);
  assert.equal(JSON.stringify(read.body).includes('secret-value'), false);
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), NAMES);
  assert.equal(catalog.body.fields[5].classification, 'operator_credential');
  assert.deepEqual(catalog.body.fields[0].editability, { available: false, scope: 'user',
    reason: 'process_environment' });
  assert.equal(catalog.body.fields[4].editability.available, false);
  assert.equal((await call('', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('?filter=1')).status, 400);
  assert.equal((await call('', { method: 'DELETE' })).status, 405);
});

test('environment projector stays fail-closed against service drift', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); this.statusCode = 200; } };
  const good = await snapshot().read(PERMITTED);
  const dispatch = (value) => dispatchNndConfigurationRequest(request, response, { url: new URL(base, 'http://localhost'),
    principal: PERMITTED, nndEnvironmentSnapshotService: { read: () => value } });
  await dispatch(good);
  assert.deepEqual(Object.keys(response.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'observation_digest', 'observed', 'environment_scope']);
  await dispatch({ ...good, private_future_field: 'FUTURE' });
  assert.equal(JSON.stringify(response.body).includes('FUTURE'), false,
    'private service fields are dropped, not rejected');
  for (const drifted of [
    { ...good, observed: good.observed.slice(0, 6) },
    { ...good, observed: good.observed.map((entry) => ({ ...entry, value: entry.value ?? 'leak' })) },
    { ...good, observation_digest: 'zz'.repeat(32) },
    { ...good, environment_scope: 'login_scope' },
  ]) {
    await assert.rejects(dispatch(drifted), { code: 'nnd_environment_request_invalid' },
      JSON.stringify(drifted).slice(0, 60));
  }
});

test('environment HTTP holds every legal large state and refuses oversize with 413', async t => {
  const value = (char, count = 16384) => char.repeat(count);
  const legal = { NNA_HOME: value('a'), NNA_PROVIDER_ENDPOINT: value('b'), NNA_MODEL: value('c'),
    NNA_REDUCED_MOTION: value('d'), NO_COLOR: value('e') };
  const legalCall = await httpFixture(t, legal);
  const read = await legalCall();
  assert.equal(read.status, 200, 'five maximum-size legal values still read successfully');
  assert.ok(Buffer.byteLength(JSON.stringify(read.body)) <= 524288);
  assert.equal(read.body.observed.map((entry) => entry.value ? entry.value.length : 0).reduce((a, b) => a + b, 0),
    81920);
  assert.equal(read.body.observed.filter((entry) => entry.value === null).length, 2,
    'credentials stay value-free even at maximum legal size');
  assert.equal((await legalCall('/catalog')).status, 200);
  const oversizeCall = await httpFixture(t, { NNA_MODEL: value('x', 16385) });
  const refused = await oversizeCall();
  assert.equal(refused.status, 413, 'oversize refusal maps to 413, not a request-blaming 400');
  assert.equal(refused.body.error.code, 'nnd_environment_value_too_large');
});
