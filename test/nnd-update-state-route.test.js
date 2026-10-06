// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndUpdateStateStore, projectUpdateState } from '../src/nnd-update-state-route.js';
import { startIntegrationServer } from '../src/integration-server.js';

const base = '/v1/nnd/configuration/update-state';
const token = 'update-state-http-test-token-31-characters-lon';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const FIELDS = ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag',
  'latest_sha', 'error_code'];
const recorded = { format: 1, checked_at: '2026-10-06T01:02:03.004Z', status: 'ready',
  latest_version: '20261007-1', latest_ref: 'main', latest_tag: null,
  latest_sha: 'a'.repeat(40), error_code: null };

test('update-state store reads the worker file and projects census fields or honest absence', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-update-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'update-state.json');
  const store = () => createNndUpdateStateStore({ path, installationId: 'install_test', dataId: 'data_test' });
  let basis = await store().read();
  assert.deepEqual(basis.fields, FIELDS);
  let value = projectUpdateState(basis);
  assert.deepEqual(Object.keys(value), ['installation_id', 'data_id', 'scope', 'schema_version', 'state']);
  assert.equal(value.state, 'absent', 'no record yet is honest absence, not a guessed shape');
  await writeFile(path, JSON.stringify({ ...recorded, installed_at: '2026-10-06T02:00:00.000Z' }));
  value = projectUpdateState(await store().read());
  assert.deepEqual(Object.keys(value), ['installation_id', 'data_id', 'scope', 'schema_version', 'state',
    'format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code']);
  assert.equal(value.latest_version, '20261007-1');
  assert.equal(value.latest_tag, null);
  assert.equal(value.error_code, null);
  assert.equal('installed_at' in value, false, 'unclassified store fields stay unprojected');
  await writeFile(path, JSON.stringify({ ...recorded, status: 'unavailable', latest_version: null,
    latest_sha: null, error_code: 'update_check_timeout' }));
  const unavailable = projectUpdateState(await store().read());
  assert.deepEqual([unavailable.status, unavailable.error_code, unavailable.latest_version],
    ['unavailable', 'update_check_timeout', null]);
});

test('update-state projection refuses drift but accepts the store validator full grammar', async () => {
  const basis = { state: recorded, installationId: 'install_test', dataId: 'data_test', fields: FIELDS };
  // Store-grammar acceptance: things the store validator accepts project as stored.
  for (const accepted of [
    { ...recorded, latest_version: 'v20261007-1' },
    { ...recorded, latest_version: '20261007-999999999' },
    { ...recorded, checked_at: '2026-10-06T01:02:03+02:00' },
    { ...recorded, latest_ref: 'release/v1:main ' },
    { ...recorded, status: 'unavailable', latest_version: null, latest_sha: null, error_code: null },
  ]) assert.equal(projectUpdateState({ ...basis, state: accepted }).state, 'recorded',
    JSON.stringify(accepted).slice(0, 60));
  for (const drifted of [
    { ...basis, fields: FIELDS.slice(0, 7) },
    { ...basis, installationId: 'invalid identity string' },
    null, undefined,
    { ...basis, state: { ...recorded, format: 2 } },
    { ...basis, state: { ...recorded, checked_at: 'not-a-date' } },
    { ...basis, state: { ...recorded, latest_version: 'nonsense' } },
    { ...basis, state: { ...recorded, latest_sha: 'z'.repeat(40) } },
    { ...basis, state: { ...recorded, status: 'paused' } },
  ]) assert.throws(() => projectUpdateState(drifted), { code: 'nnd_update_state_request_invalid' });
});

async function httpFixture(t, fileBody) {
  const root = await mkdtemp(join(homedir(), '.nna-update-state-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'update-state.json');
  if (fileBody !== undefined) await writeFile(path, JSON.stringify(fileBody));
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndUpdateStateStore: createNndUpdateStateStore(
      { path, installationId: 'install_test', dataId: 'data_test' }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', bearer = token, search = '' } = {}) => {
    const response = await fetch(endpoint + base + suffix + search,
      { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() };
  };
}

test('update-state HTTP projects the recorded check, honest absence, and read-only catalog', async t => {
  const call = await httpFixture(t, { ...recorded, installed_at: '2026-10-06T02:00:00.000Z' });
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.state, 'recorded');
  assert.equal(read.body.latest_version, '20261007-1');
  assert.equal(JSON.stringify(read.body).includes('installed_at'), false);
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), FIELDS);
  assert.equal(catalog.body.fields[0].editability.available, false);
  assert.equal(catalog.body.fields[0].editability.reason, 'generated_state');
  assert.equal(catalog.body.fields[4].classification, 'generated_state');
  assert.equal((await call('', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('', { search: '?refresh=1' })).status, 400);
  assert.equal((await call('/catalog', { search: '?x=1' })).status, 400);
  const absent = await httpFixture(t, undefined);
  const empty = await absent();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.state, 'absent');
  const corrupt = await httpFixture(t, { format: 9, status: 'lying' });
  const read2 = await corrupt();
  assert.equal(read2.status, 200);
  assert.equal(read2.body.state, 'absent', 'a corrupt store reads as absence, failing closed');
});
