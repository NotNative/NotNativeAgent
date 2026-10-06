// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndWebSearchSettingsTransaction } from '../src/nnd-web-search-transaction.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';

const base = '/v1/nnd/configuration/web-search';
const selected = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'websearch-http-test-token-33-characters-longX';

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-websearch-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  await mkdir(config);
  const path = join(config, 'web-search.json');
  await writeFile(path, JSON.stringify({ version: 2, enabled: false, profiles: [], private_future_field: 'FUTURE' }));
  let permissions = ['nnd.configuration.read'];
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com', permissions }),
    nndWebSearchSettingsService: createNndWebSearchSettingsTransaction({ path,
      installationId: selected.installation_id, dataId: selected.data_id }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  async function call(suffix = '', { method = 'GET', body, bearer = token } = {}) {
    const response = await fetch(endpoint + base + suffix, { method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { path, call, permissions: (value) => { permissions = value; } };
}

const add = (display_name, endpoint) => ({ op: 'add_profile', display_name, endpoint });

test('native web-search HTTP projects the settings family and performs CAS saves', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('', { bearer: null })).status, 401);
  const read = await f.call();
  assert.equal(read.status, 200);
  assert.equal(read.body.enabled, false);
  assert.deepEqual(read.body.profiles, []);
  assert.equal(read.body.version, 2);
  assert.equal(read.body.application, 'next_search');
  assert.equal(read.body.project_shadowed, false);
  const catalog = await f.call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), ['enabled', 'profiles', 'version']);
  assert.equal(catalog.body.fields[1].type, 'array');
  assert.deepEqual(catalog.body.fields[1].operations, ['add_profile', 'promote_profile', 'remove_profile']);
  assert.equal(catalog.body.fields[1].editability.available, true);
  assert.equal(catalog.body.fields[2].editability.available, false);
  const ops = (revision, operations = [], operationId) => ({ ...selected, expected_revision: revision,
    expected_resolution_revision: revision, operations, ...(operationId ? { operation_id: operationId } : {}) });
  // Fixture starts read-only: management calls are denied before any mutation.
  assert.equal((await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [add('Docs', 'https://searx.docs.example')], 'http_denied') })).status, 403);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const preview = await f.call('/preview', { method: 'POST',
    body: ops(read.body.source_revision, [add('Docs', 'https://searx.docs.example')]) });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.view.profiles.map((profile) => profile.id), ['docs']);
  assert.equal(preview.body.view.enabled, true, 'the domain enables when a profile lands');
  const saved = await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [add('Docs', 'https://searx.docs.example')], 'http_add') });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.persistence, 'saved');
  assert.equal(saved.body.next_action, 'next_search');
  const operation = await f.call('/operations/http_add');
  assert.equal(operation.status, 200);
  assert.equal(operation.body.persisted_revision, saved.body.persisted_revision);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(stored.profiles.map((profile) => profile.id), ['docs']);
  assert.equal(stored.enabled, true);
  assert.equal(stored.private_future_field, 'FUTURE');
  for (const result of [read, catalog, preview, saved, operation]) {
    assert.equal(JSON.stringify(result.body).includes('FUTURE'), false);
  }
  const stale = await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [{ op: 'promote_profile', id: 'docs' }], 'stale_save') });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'manifest_revision_conflict');
  assert.equal((await f.call('/operations/stale_save')).status, 404);
});

test('web-search HTTP refuses foreign identity, malformed ops, query, and wrong methods without source mutation', async t => {
  const f = await fixture(t);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const read = await f.call();
  const input = (operations, extra = {}) => ({ ...selected, expected_revision: read.body.source_revision,
    expected_resolution_revision: read.body.resolution_revision, operations, ...extra });
  const before = await readFile(f.path);
  for (const body of [
    input([add('Docs', 'https://searx.docs.example')], { data_id: 'foreign' }),
    input([{ op: 'add_profile', display_name: 'x', endpoint: 'https://a.example', extra: 1 }]),
    input([]),
  ]) {
    const result = await f.call('/preview', { method: 'POST', body });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'nnd_web_search_request_invalid');
  }
  // Shape errors that the op canonicalizer forwards keep their governed domain codes.
  for (const [body, code] of [
    [input([add('Docs', 'https://user:secret@searx.docs.example')]), 'web_search_endpoint_invalid'],
    [input([{ op: 'promote_profile', id: 'UPPER' }]), 'web_search_profile_id_invalid'],
    [input([add('Docs', 'not a url')]), 'web_search_endpoint_invalid'],
  ]) {
    const result = await f.call('/preview', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, code);
  }
  assert.equal((await f.call('/preview', { method: 'GET' })).status, 405);
  assert.equal((await f.call('?profile=1')).status, 400);
  assert.equal((await f.call('/operations/unknown')).status, 404);
  assert.deepEqual(await readFile(f.path), before);
});

test('web-search HTTP projects an absent file as sticky defaults and bootstraps through save', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-websearch-http-absent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'web-search.json');
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com',
      permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] }),
    nndWebSearchSettingsService: createNndWebSearchSettingsTransaction({ path,
      installationId: selected.installation_id, dataId: selected.data_id }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const call = async (suffix = '', init = {}) => {
    const response = await fetch(endpoint + base + suffix, { method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const absent = await call();
  assert.equal(absent.status, 200);
  assert.equal(absent.body.source_state, 'absent');
  assert.equal(absent.body.source_revision, 'absent');
  assert.deepEqual(absent.body.profiles, []);
  const preview = await call('/preview', { method: 'POST', body: { ...selected,
    expected_revision: 'absent', expected_resolution_revision: 'absent',
    operations: [add('Docs', 'https://searx.docs.example')] } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.view.profiles.map((profile) => profile.id), ['docs']);
  const saved = await call('/save', { method: 'POST', body: { ...selected,
    expected_revision: 'absent', expected_resolution_revision: 'absent', operation_id: 'absent_bootstrap',
    operations: [add('Docs', 'https://searx.docs.example')] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.next_action, 'next_search');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored.profiles.map((profile) => profile.id), ['docs']);
  assert.equal(stored.enabled, true);
});

test('web-search route projector ignores private fields even when the service returns them', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); this.statusCode = 200; } };
  const baseView = { ...selected, source_state: 'present', source_revision: 'a'.repeat(64),
    resolution_revision: 'a'.repeat(64), project_shadowed: false, version: 2, enabled: true,
    profiles: [{ id: 'docs', display_name: 'Docs', provider: 'searxng', endpoint: 'https://a.example', managed: false }],
    application: 'next_search' };
  await dispatchNndConfigurationRequest(request, response, { url: new URL(base, 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndWebSearchSettingsService: { preview() {}, save() {}, operation() {},
      read: () => ({ ...baseView, private_future_field: 'FUTURE' }) } });
  assert.deepEqual(Object.keys(response.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'source_state', 'source_revision', 'resolution_revision', 'project_shadowed', 'version', 'enabled', 'profiles',
    'application']);
  assert.equal(JSON.stringify(response.body).includes('FUTURE'), false);
});

test('web-search catalog is unavailable without the complete native transaction service', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end() {} };
  await assert.rejects(dispatchNndConfigurationRequest(request, response, {
    url: new URL(base + '/catalog', 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndConfigurationService: {},
  }), { code: 'nnd_configuration_unavailable' });
});
