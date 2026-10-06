// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndCompatibilitySettingsTransaction }
  from '../src/nnd-compatibility-transaction.js';
import { readManifestSnapshot } from '../src/persistence/manifest-transaction.js';
import { startIntegrationServer } from '../src/integration-server.js';

const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const readOnly = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const identity = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'compatibility-http-test-token-38-chars';
const SECRET = 'c'.repeat(24);

function candidate(overrides = {}) {
  return { enabled: true, hostname: '127.0.0.1', port: 4096, username: 'opencode', ...overrides };
}

async function fixture(t, init) {
  const root = await mkdtemp(join(homedir(), '.nna-compat-tx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'opencode.json');
  if (init) await writeFile(path, JSON.stringify(init));
  const service = createNndCompatibilitySettingsTransaction(
    { path, installationId: identity.installation_id, dataId: identity.data_id, environment: {} });
  const request = (revision, view, password, operationId) => ({ ...identity, expected_revision: revision,
    expected_resolution_revision: revision, view, password, ...(operationId ? { operation_id: operationId } : {}) });
  const read = async () => {
    const view = await service.read(principal);
    return { view, request: (candidate, password) => request(view.source_revision, candidate, password ?? { action: 'keep' }) };
  };
  return { path, service, request, read };
}

const assertNoSecret = (value, label) => assert.equal(JSON.stringify(value).includes(SECRET), false,
  `${label} must never carry a secret value`);

test('an absent file reads as the sticky wire identity and a preview bootstraps without persisting', async t => {
  const f = await fixture(t);
  const read = await f.service.read(principal);
  assert.equal(read.source_state, 'absent');
  assert.equal(read.source_revision, 'absent');
  assert.deepEqual([read.version, read.enabled, read.hostname, read.port, read.username],
    [1, false, '127.0.0.1', 4095, 'opencode']);
  assert.deepEqual(read.password, { configured: false, source: null });
  assert.equal(read.updated_at, null);
  assert.equal(read.application, 'next_service_start');
  const before = await readFile(f.path).then(() => 'exists', (error) => error.code);
  assert.equal(before, 'ENOENT');
  const preview = await f.service.preview(principal,
    await f.read().then(x => x.request(candidate({ enabled: true }))));
  assert.equal(preview.valid, true);
  assert.equal(preview.enabled, true);
  assert.deepEqual(preview.password, { configured: false, source: null });
  assert.equal(await readFile(f.path).then(() => 'exists', (error) => error.code), 'ENOENT');
  const readAgain = await f.read();
  await assert.rejects(() => f.service.preview(readOnly, readAgain.request(candidate())),
    { code: 'integration_permission_denied' }, 'preview and save need the manage right');
});

test('the domain validates candidates: exposed bind, short password, and secret replace stick', async t => {
  const f = await fixture(t);
  const { request } = await f.read();
  await assert.rejects(() => f.service.preview(principal, request(candidate({ hostname: '0.0.0.0' }))),
    { code: 'opencode_bind_exposed_requires_password' },
    'an unauthenticated bind beyond loopback fails closed');
  const replace = await f.service.preview(principal,
    request(candidate({ hostname: '0.0.0.0' }), { action: 'replace', value: SECRET }));
  assert.equal(replace.enabled, true);
  assert.deepEqual(replace.password, { configured: true, source: 'restricted local config' });
  assertNoSecret(replace, 'preview');
  await assert.rejects(() => f.service.preview(principal,
    request(candidate(), { action: 'replace', value: 'short' })), { code: 'opencode_password_invalid' });
  await assert.rejects(() => f.service.preview(principal,
    request(candidate({ port: 65_536 }))), { code: 'opencode_bind_port_invalid' });
  const cleared = await f.service.preview(principal, request(candidate({ hostname: '127.0.0.1' }), { action: 'clear' }));
  assert.deepEqual(cleared.password, { configured: false, source: null });
  await assert.rejects(() => f.service.preview(principal, request({ ...candidate(), extra: 1 }, { action: 'keep' })),
    { code: 'nnd_compatibility_request_invalid' }, 'unknown candidate keys are refused');
  const saved = await f.service.save(principal, { ...request(candidate({ enabled: true }), { action: 'replace', value: SECRET }), operation_id: 'enable_secret_save' });
  assert.equal(saved.persistence, 'saved');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.enabled, true);
  assert.equal(stored.password, SECRET);
  assert.equal(typeof stored.updated_at, 'string');
  const after = await f.service.read(principal);
  assert.deepEqual(after.password, { configured: true, source: 'restricted local config' });
  assertNoSecret(after, 'read');
  assert.notEqual(after.source_revision, 'absent');
  const afterRequest = (await f.read()).request;
  const clearedSave = await f.service.save(principal, { ...afterRequest(candidate(), { action: 'clear' }), operation_id: 'clear_save' });
  assert.equal(clearedSave.persistence, 'saved');
  const clearedStored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal('password' in clearedStored, false, 'a cleared secret leaves the file honest');
});

test('CAS receipts replay, persist revisions, and repair demands stay honest for a corrupt store', async t => {
  const f = await fixture(t);
  const { request } = await f.read();
  const first = await f.service.save(principal, { ...request(candidate({ enabled: true })), operation_id: 'enable_first' });
  assert.equal(first.persistence, 'saved');
  const recurrence = await f.service.save(principal, { ...request(candidate(), { action: 'keep' }), operation_id: 'enable_first' });
  assert.deepStrictEqual([recurrence.persistence, recurrence.replayed], [first.persistence, true],
    'a repeated operation keeps its recorded receipt even when the revision moved on');
  const secondRequest = (await f.read()).request;
  const second = await f.service.save(principal, { ...secondRequest(candidate({ enabled: false })), operation_id: 'disable_second' });
  assert.equal((await JSON.parse(await readFile(f.path, 'utf8'))).enabled, false);
  assert.notEqual(second.persisted_revision, first.persisted_revision);
  assert.equal(await f.service.operation(principal, 'never_happened'), null);
  await assert.rejects(() =>
    f.service.save(principal, { ...request(candidate({ enabled: true })), operation_id: 'stale_cas' }),
    { code: 'manifest_revision_conflict' }, 'a stale revision is refused before publishing');
  // Semantic corruption (an unsupported file version) must fail closed: the read refuses
  // and a well-revisioned save still refuses to normalize the broken store.
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(await readFile(f.path, 'utf8')), version: 2 }));
  await assert.rejects(() => f.service.read(principal), { code: 'nnd_compatibility_source_invalid' });
  const snapshot = await readManifestSnapshot(f.path);
  await assert.rejects(() => f.service.save(principal, {
    ...f.request(snapshot.revision, candidate(), { action: 'clear' }, 'corrupt_save') }),
    { code: 'nnd_compatibility_source_invalid' });
});

function body(request) { return Readable.from([JSON.stringify(request)]); }

async function httpFixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-compat-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'opencode.json');
  const principalBox = { value: principal };
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => principalBox.value, nndCompatibilitySettingsService: createNndCompatibilitySettingsTransaction(
      { path, installationId: identity.installation_id, dataId: identity.data_id, environment: {} }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const base = '/v1/nnd/configuration/compatibility-service';
  const call = async (suffix = '', { method = 'GET', bearer = token, search = '', principalOverride,
    value } = {}) => {
    if (principalOverride) principalBox.value = principalOverride;
    try {
      const response = await fetch(endpoint + base + suffix + search, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(value !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
      return { status: response.status, body: await response.json().catch(() => null) };
    } finally { if (principalOverride) principalBox.value = principal; }
  };
  return { call, path };
}

test('compatibility HTTP offers the catalog, receipts, protects the secret, and gates by permission', async t => {
  const { call, path } = await httpFixture(t);
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.source_state, 'absent');
  assert.deepEqual(read.body.password, { configured: false, source: null });
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path),
    ['version', 'enabled', 'hostname', 'port', 'username', 'password', 'updated_at']);
  assert.equal(catalog.body.fields[5].operations.join(','), 'replace_secret,clear_secret');
  assert.equal(catalog.body.fields[5].type, 'secret');
  assert.equal(catalog.body.fields[0].editability.reason, 'generated_state');
  assert.equal(catalog.body.fields[6].editability.reason, 'generated_state');
  assert.equal((await call('', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('', { search: '?refresh=1' })).status, 400);
  assert.equal((await call('/save', { method: 'POST', principalOverride: readOnly, value: {} })).status, 403);
  assert.equal((await call('/operations/nada')).status, 404);
  const replaced = await f_request(call, candidate({ enabled: true }), { action: 'replace', value: SECRET });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.valid, true);
  assertNoSecret(replaced, 'preview response');
  const saved = await f_save(call, candidate({ enabled: true }), { action: 'replace', value: SECRET }, 'http_secret_save');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.persistence, 'saved');
  assertNoSecret(saved, 'receipt');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.password, SECRET);
  const persisted = saved.body.persisted_revision;
  const receipt2 = await call(`/operations/${saved.body.operation_id}`);
  assert.deepEqual(receipt2.body.persisted_revision, persisted);
  assert.equal(JSON.stringify(receipt2.body).includes(SECRET), false, 'stored receipts carry no secrets');
});

async function f_request(call, view, password) {
  const base = await call();
  return call('/preview', { method: 'POST', value: { ...identity,
    expected_revision: base.body.source_revision, expected_resolution_revision: base.body.source_revision,
    view, password } });
}
async function f_save(call, view, password, operationId) {
  const base = await call();
  return call('/save', { method: 'POST', value: { ...identity,
    expected_revision: base.body.source_revision, expected_resolution_revision: base.body.source_revision,
    view, password, operation_id: operationId } });
}
