// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndWebSearchSettingsTransaction } from '../src/nnd-web-search-transaction.js';
import { readManifestSnapshot } from '../src/persistence/manifest-transaction.js';

const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const readOnly = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const identity = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };

async function fixture(t, init) {
  const root = await mkdtemp(join(homedir(), '.nna-websearch-tx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'web-search.json');
  if (init) await writeFile(path, JSON.stringify(init));
  const service = createNndWebSearchSettingsTransaction({ path, installationId: identity.installation_id, dataId: identity.data_id });
  const ops = (revision, operations, operationId) => ({ ...identity, expected_revision: revision,
    expected_resolution_revision: revision, operations, ...(operationId ? { operation_id: operationId } : {}) });
  const enable = (enabled) => ({ op: 'set_enabled', enabled });
  const add = (display_name, endpoint) => ({ op: 'add_profile', display_name, endpoint });
  const promote = (id) => ({ op: 'promote_profile', id });
  const remove = (id) => ({ op: 'remove_profile', id });
  return { path, service, ops, enable, add, promote, remove };
}

test('an absent file reads as sticky defaults and the add preview bootstraps without persisting', async t => {
  const f = await fixture(t);
  const read = await f.service.read(principal);
  assert.equal(read.source_state, 'absent');
  assert.equal(read.source_revision, 'absent');
  assert.equal(read.enabled, false);
  assert.deepEqual(read.profiles, []);
  assert.equal(read.version, 2);
  assert.equal(read.application, 'next_search');
  const before = await readFile(f.path).then(() => 'exists', (error) => error.code);
  assert.equal(before, 'ENOENT');
  const preview = await f.service.preview(principal, f.ops('absent', [f.add('Docs Search', 'https://searx.docs.example')]));
  assert.equal(preview.valid, true);
  // CLI parity: the domain helper enables when a profile lands, so an add on the
  // absent basis previews an enabled configuration.
  assert.equal(preview.enabled, true);
  assert.deepEqual(preview.profiles.map((profile) => [profile.id, profile.display_name, profile.endpoint]),
    [['docs-search', 'Docs Search', 'https://searx.docs.example']]);
  assert.equal(await readFile(f.path).then(() => 'exists', (error) => error.code), 'ENOENT');
});

test('a save from the absent basis creates the file and stamps the receipt for the next search', async t => {
  const f = await fixture(t);
  const saved = await f.service.save(principal, {
    ...f.ops('absent', [f.add('Docs Search', 'https://searx.docs.example'), f.enable(true)]), operation_id: 'first_add' });
  assert.equal(saved.persistence, 'saved');
  assert.equal(saved.application, 'next_search');
  assert.equal(saved.next_action, 'next_search');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.profiles.map((profile) => profile.id), ['docs-search']);
  const operation = await f.service.operation(principal, 'first_add');
  assert.equal(operation.persistence, 'saved');
  assert.deepEqual(operation.persisted_revision, saved.persisted_revision);
});

test('enabling without a profile keeps the domain refusal and disable stays legal with no profiles', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.preview(principal, f.ops('absent', [f.enable(true)])),
    { code: 'web_search_endpoint_required' });
  await f.service.save(principal, { ...f.ops('absent', [f.enable(false)]), operation_id: 'noop_enable' });
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.enabled, false);
  assert.deepEqual(stored.profiles, []);
});

test('profile ids, endpoints, and ordering canonicalize exactly like the store normalizes them', async t => {
  const f = await fixture(t);
  await f.service.save(principal, {
    ...f.ops('absent', [f.add('Primary Work', 'https://searx.work.example:8443/'),
      f.add('Docs Search', 'https://searx.docs.example/search/')]), operation_id: 'seed' });
  let read = await f.service.read(principal);
  // Insertion order with the domain slug ids; trailing /search and bare trailing slash collapse to the base URL.
  assert.deepEqual(read.profiles.map((profile) => [profile.id, profile.endpoint, profile.provider, profile.managed]),
    [['primary-work', 'https://searx.work.example:8443', 'searxng', false],
      ['docs-search', 'https://searx.docs.example', 'searxng', false]]);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.promote('docs-search')]), operation_id: 'promote' });
  read = await f.service.read(principal);
  assert.deepEqual(read.profiles.map((profile) => profile.id), ['docs-search', 'primary-work']);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.remove('docs-search')]), operation_id: 'drop' });
  read = await f.service.read(principal);
  assert.deepEqual(read.profiles.map((profile) => profile.id), ['primary-work']);
  assert.equal(read.enabled, true);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.remove('primary-work'), f.add('More', 'https://other.example')]),
    operation_id: 'reshuffle' });
  read = await f.service.read(principal);
  assert.deepEqual(read.profiles.map((profile) => profile.display_name), ['More']);
  // CLI parity: the appended profile re-enables the family after the removals left it empty.
  assert.equal(read.enabled, true);
});

test('grammar violations stay request-level errors while domain semantics keep their own codes', async t => {
  const f = await fixture(t, { version: 2, enabled: false, profiles: [] });
  const read = await f.service.read(principal);
  const base = f.ops(read.source_revision, [f.add('Docs Search', 'https://searx.docs.example')]);
  const cases = [
    { ...base, data_id: 'foreign' }, { ...base, installation_id: 'foreign' }, { ...base, scope: 'shared' },
    { ...base, expected_revision: 'a'.repeat(64) }, { ...base, expected_resolution_revision: 'a'.repeat(64) },
    { ...identity, expected_revision: read.source_revision, expected_resolution_revision: read.source_revision },
    { ...base, operations: [] }, { ...base, operations: Array.from({ length: 17 }, () => f.add('More', 'https://x.example')) },
    { ...base, operations: [{ op: 'add_profile', display_name: 'Docs Search', endpoint: 'https://searx.docs.example', extra: 1 }] },
    { ...base, operations: [{ op: 'add_profile', endpoint: 'https://searx.docs.example' }] },
    { ...base, operations: [{ op: 'set_enabled', enabled: 'yes' }] },
    { ...base, operations: [{ op: 'promote_profile' }] },
    { ...base, operations: [{ op: 'set_profile', id: 'docs-search' }] },
  ];
  for (const input of cases) {
    await assert.rejects(f.service.preview(principal, input), { code: 'nnd_web_search_request_invalid' });
  }
  // Domain semantic refusals keep their governed codes, including the shape errors the
  // op canonicalizer forwards (an id that violates the profile-id grammar).
  await assert.rejects(f.service.preview(principal, f.ops(read.source_revision, [f.add('Docs', 'not a url')])),
    { code: 'web_search_endpoint_invalid' });
  await assert.rejects(f.service.preview(principal, f.ops(read.source_revision, [f.remove('X_Y')])),
    { code: 'web_search_profile_id_invalid' });
  await assert.rejects(f.service.save(principal, { ...f.ops(read.source_revision, [f.promote('ghost')]), operation_id: 'ghost' }),
    { code: 'web_search_profile_missing' });
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.add('Docs Search', 'https://searx.docs.example')]),
    operation_id: 'one_add' });
  const reread = await f.service.read(principal);
  await assert.rejects(f.service.preview(principal, f.ops(reread.source_revision,
    [f.add('Again', 'https://searx.docs.example')])), { code: 'web_search_endpoint_duplicate' });
  await assert.rejects(f.service.preview(readOnly, base), { code: 'integration_permission_denied' });
  const readonlyRead = await f.service.read(readOnly);
  assert.deepEqual(readonlyRead.profiles.map((profile) => profile.id), ['docs-search']);
  const after = await readFile(f.path, 'utf8');
  assert.deepEqual(JSON.parse(after), JSON.parse(JSON.stringify({ version: 2, enabled: true, profiles:
    [{ id: 'docs-search', display_name: 'Docs Search', provider: 'searxng', endpoint: 'https://searx.docs.example', managed: false }] })));
});

test('stale revisions conflict and replays keep their recorded receipts through the pre-read', async t => {
  const f = await fixture(t);
  const saved = await f.service.save(principal, { ...f.ops('absent', [f.add('Docs', 'https://searx.docs.example')]), operation_id: 'op_a' });
  const reread = await f.service.read(principal);
  await assert.rejects(
    f.service.save(principal, { ...f.ops('absent', [f.add('More', 'https://searx.more.example')]), operation_id: 'stale_op' }),
    { code: 'manifest_revision_conflict' });
  assert.equal((await f.service.operation(principal, 'stale_op')) ?? null, null);
  const replayed = await f.service.save(principal, { ...f.ops('absent', [f.add('Docs', 'https://searx.docs.example')]), operation_id: 'op_a' });
  assert.equal(replayed.persistence, saved.persistence);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.persisted_revision, saved.persisted_revision);
  const fresh = await f.service.save(principal, { ...f.ops(reread.source_revision, [f.add('More', 'https://searx.more.example')]),
    operation_id: 'op_b' });
  assert.equal(fresh.persistence, 'saved');
  const final = await f.service.read(principal);
  assert.deepEqual(final.profiles.map((profile) => profile.id), ['docs', 'more']);
});

test('a corrupt file fails closed; a well-formed empty config at a future version stays legal state', async t => {
  // The domain has no version gate, so a well-formed empty config reads fine even at a
  // foreign version value; corruption means semantically rejected documents.
  const legal = await fixture(t, { version: 3, enabled: false, profiles: [] });
  const legalRead = await legal.service.read(principal);
  assert.equal(legalRead.enabled, false);
  assert.equal(legalRead.source_state, 'present');
  for (const broken of [{ version: 2, enabled: true, profiles: [] },
    { version: 2, enabled: false, profiles: [{ id: 'bad id' }] }]) {
    const f = await fixture(t, broken);
    await assert.rejects(f.service.read(principal), { code: 'nnd_web_search_source_invalid' });
    const snapshot = await readManifestSnapshot(f.path);
    await assert.rejects(
      f.service.preview(principal, f.ops(snapshot.revision, [f.enable(true)])),
      { code: 'nnd_web_search_source_invalid' });
    await assert.rejects(
      f.service.save(principal, { ...f.ops(snapshot.revision, [f.enable(false)]), operation_id: 'broken_save' }),
      { code: 'nnd_web_search_source_invalid' });
  }
});

test('unknown raw fields survive a native save without appearing in the projection', async t => {
  const f = await fixture(t, { version: 2, enabled: false, profiles: [], private_future_field: 'FUTURE' });
  const read = await f.service.read(principal);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.add('Docs', 'https://searx.docs.example')]),
    operation_id: 'keep_raw' });
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.private_future_field, 'FUTURE');
  const reread = await f.service.read(principal);
  assert.equal(JSON.stringify(reread).includes('FUTURE'), false);
  assert.deepEqual(Object.keys(reread).sort(), ['application', 'data_id', 'enabled', 'installation_id',
    'profiles', 'project_shadowed', 'resolution_revision', 'scope', 'source_revision', 'source_state', 'version']);
});
