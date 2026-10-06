// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndWebFetchSettingsTransaction } from '../src/nnd-web-fetch-transaction.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';

const base = '/v1/nnd/configuration/web-fetch';
const selected = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'webfetch-http-test-token-32-characters-long';

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-webfetch-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  await mkdir(config);
  const path = join(config, 'web-fetch.json');
  await writeFile(path, JSON.stringify({ version: 1, trusted_origins: [], private_future_field: 'FUTURE' }));
  let permissions = ['nnd.configuration.read'];
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com', permissions }),
    nndWebFetchSettingsService: createNndWebFetchSettingsTransaction({ path,
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

test('native web-fetch HTTP projects the trust family and performs CAS saves', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('', { bearer: null })).status, 401);
  const read = await f.call();
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.trusted_origins, []);
  assert.equal(read.body.version, 1);
  assert.equal(read.body.application, 'next_fetch');
  assert.equal(read.body.project_shadowed, false);
  const catalog = await f.call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), ['trusted_origins', 'version', 'updated_at']);
  assert.equal(catalog.body.fields[0].classification, 'authority_grant');
  assert.deepEqual(catalog.body.fields[0].operations, ['trust', 'revoke']);
  assert.equal(catalog.body.fields[1].editability.available, false);
  const ops = (revision, operations = [], operationId) => ({ ...selected, expected_revision: revision,
    expected_resolution_revision: revision, operations, ...(operationId ? { operation_id: operationId } : {}) });
  // Fixture starts read-only: management calls are denied before any mutation.
  assert.equal((await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [{ op: 'trust', origin: 'https://example.com' }], 'http_denied') })).status, 403);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const preview = await f.call('/preview', { method: 'POST',
    body: ops(read.body.source_revision, [{ op: 'trust', origin: 'https://example.com' }]) });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.view.trusted_origins, ['https://example.com']);
  const saved = await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [{ op: 'trust', origin: 'https://example.com' }], 'http_trust') });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.persistence, 'saved');
  assert.equal(saved.body.next_action, 'next_fetch');
  const operation = await f.call('/operations/http_trust');
  assert.equal(operation.status, 200);
  assert.equal(operation.body.persisted_revision, saved.body.persisted_revision);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(stored.trusted_origins, ['https://example.com']);
  assert.equal(stored.private_future_field, 'FUTURE');
  for (const result of [read, catalog, preview, saved, operation]) {
    assert.equal(JSON.stringify(result.body).includes('FUTURE'), false);
  }
  const stale = await f.call('/save', { method: 'POST',
    body: ops(read.body.source_revision, [{ op: 'trust', origin: 'https://other.example' }], 'stale_save') });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'manifest_revision_conflict');
  assert.equal((await f.call('/operations/stale_save')).status, 404);
});

test('web-fetch HTTP refuses foreign identity, malformed origins, query, and wrong methods without source mutation', async t => {
  const f = await fixture(t);
  f.permissions(['nnd.configuration.read', 'nnd.configuration.manage']);
  const read = await f.call();
  const input = (operations, extra = {}) => ({ ...selected, expected_revision: read.body.source_revision,
    expected_resolution_revision: read.body.resolution_revision, operations, ...extra });
  const before = await readFile(f.path);
  for (const body of [
    input([{ op: 'trust', origin: 'https://example.com' }], { data_id: 'foreign' }),
    input([{ op: 'trust', origin: 'https://secret@example.com' }]),
    input([{ op: 'trust', origin: 'https://example.com/path' }]),
    input([{ op: 'trust', origin: 'https://example.com', extra: 1 }]),
    input([]),
  ]) {
    const result = await f.call('/preview', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'nnd_web_fetch_request_invalid');
  }
  assert.equal((await f.call('/preview', { method: 'GET' })).status, 405);
  assert.equal((await f.call('?origin=1')).status, 400);
  assert.equal((await f.call('/operations/unknown')).status, 404);
  assert.deepEqual(await readFile(f.path), before);
});

test('web-fetch HTTP projects an absent file as sticky defaults and bootstraps through save', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-webfetch-http-absent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'web-fetch.json');
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com',
      permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] }),
    nndWebFetchSettingsService: createNndWebFetchSettingsTransaction({ path,
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
  assert.deepEqual(absent.body.trusted_origins, []);
  const preview = await call('/preview', { method: 'POST', body: { ...selected,
    expected_revision: 'absent', expected_resolution_revision: 'absent',
    operations: [{ op: 'trust', origin: 'https://example.com' }] } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.view.trusted_origins, ['https://example.com']);
  const saved = await call('/save', { method: 'POST', body: { ...selected,
    expected_revision: 'absent', expected_resolution_revision: 'absent', operation_id: 'absent_bootstrap',
    operations: [{ op: 'trust', origin: 'https://example.com' }] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.next_action, 'next_fetch');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored.trusted_origins, ['https://example.com']);
});

test('web-fetch route projector ignores private fields even when the service returns them', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); this.statusCode = 200; } };
  const baseView = { ...selected, source_state: 'present', source_revision: 'a'.repeat(64),
    resolution_revision: 'a'.repeat(64), project_shadowed: false, version: 1,
    trusted_origins: ['https://example.com'], updated_at: '2026-10-06T00:00:00.000Z',
    application: 'next_fetch' };
  await dispatchNndConfigurationRequest(request, response, { url: new URL(base, 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndWebFetchSettingsService: { preview() {}, save() {}, operation() {},
      read: () => ({ ...baseView, private_future_field: 'FUTURE' }) } });
  assert.deepEqual(Object.keys(response.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'source_state', 'source_revision', 'resolution_revision', 'project_shadowed', 'version', 'trusted_origins',
    'updated_at', 'application']);
  assert.equal(JSON.stringify(response.body).includes('FUTURE'), false);
});

test('web-fetch catalog is unavailable without the complete native transaction service', async () => {
  const request = Readable.from([]); request.method = 'GET';
  const response = { setHeader() {}, end() {} };
  await assert.rejects(dispatchNndConfigurationRequest(request, response, {
    url: new URL(base + '/catalog', 'http://localhost'),
    principal: { subjectId: 'operator', permissions: ['nnd.configuration.read'] },
    nndConfigurationService: {},
  }), { code: 'nnd_configuration_unavailable' });
});
