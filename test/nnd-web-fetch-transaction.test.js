// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndWebFetchSettingsTransaction } from '../src/nnd-web-fetch-transaction.js';
import { readManifestSnapshot } from '../src/persistence/manifest-transaction.js';

const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const readOnly = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const identity = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };

async function fixture(t, init) {
  const root = await mkdtemp(join(homedir(), '.nna-webfetch-tx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'web-fetch.json');
  if (init) await writeFile(path, JSON.stringify(init));
  const service = createNndWebFetchSettingsTransaction({ path, installationId: identity.installation_id, dataId: identity.data_id });
  const ops = (revision, operations, operationId) => ({ ...identity, expected_revision: revision,
    expected_resolution_revision: revision, operations, ...(operationId ? { operation_id: operationId } : {}) });
  const trust = (origin) => ({ op: 'trust', origin });
  const revoke = (origin) => ({ op: 'revoke', origin });
  return { path, service, ops, trust, revoke };
}

test('an absent file reads as sticky defaults and the trust preview bootstraps without persisting', async t => {
  const f = await fixture(t);
  const read = await f.service.read(principal);
  assert.equal(read.source_state, 'absent');
  assert.equal(read.source_revision, 'absent');
  assert.deepEqual(read.trusted_origins, []);
  assert.equal(read.updated_at, null);
  assert.equal(read.application, 'next_fetch');
  const before = await readFile(f.path).then(() => 'exists', (error) => error.code);
  assert.equal(before, 'ENOENT');
  const preview = await f.service.preview(principal, f.ops('absent', [f.trust('https://example.com')]));
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.trusted_origins, ['https://example.com']);
  assert.equal(await readFile(f.path).then(() => 'exists', (error) => error.code), 'ENOENT');
});

test('a save from the absent basis bootstraps the file and stamps the receipt for the next fetch', async t => {
  const f = await fixture(t);
  const saved = await f.service.save(principal, { ...f.ops('absent', [f.trust('https://example.com')]), operation_id: 'first_trust' });
  assert.equal(saved.persistence, 'saved');
  assert.equal(saved.application, 'next_fetch');
  assert.equal(saved.next_action, 'next_fetch');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(stored.trusted_origins, ['https://example.com']);
  assert.equal(stored.version, 1);
  assert.equal(typeof stored.updated_at, 'string');
  const operation = await f.service.operation(principal, 'first_trust');
  assert.equal(operation.persistence, 'saved');
  assert.deepEqual(operation.persisted_revision, saved.persisted_revision);
});

test('origin values are canonicalized the same way the store normalizes them', async t => {
  const f = await fixture(t);
  const longHost = `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.d6org.example`;
  const legalLong = `https://${longHost}:8443`;
  await f.service.save(principal, { ...f.ops('absent', [f.trust(legalLong)]), operation_id: 'long_host' });
  const read = await f.service.read(principal);
  assert.deepEqual(read.trusted_origins, [`https://${longHost}:8443`]);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.trust('https://Example.com/')]), operation_id: 'case_host' });
  const reread = await f.service.read(principal);
  assert.deepEqual(reread.trusted_origins, [`https://${longHost}:8443`, 'https://example.com']);
  await f.service.save(principal, { ...f.ops(reread.source_revision, [f.trust('https://example.com'), f.trust('https://other.example')]),
    operation_id: 'dedupe' });
  const final = await f.service.read(principal);
  assert.deepEqual(final.trusted_origins, [`https://${longHost}:8443`, 'https://example.com', 'https://other.example']);
});

test('revoke removes a listed origin and keeps the remainder sorted', async t => {
  const f = await fixture(t);
  await f.service.save(principal, { ...f.ops('absent', [f.trust('https://z.example'), f.trust('https://a.example')]), operation_id: 'seed' });
  const read = await f.service.read(principal);
  assert.deepEqual(read.trusted_origins, ['https://a.example', 'https://z.example']);
  // CLI parity: revoking an origin that is not listed stays a valid no-op save.
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.revoke('https://absent.example')]), operation_id: 'noop' });
  await f.service.save(principal, { ...f.ops((await f.service.read(principal)).source_revision, [f.revoke('https://z.example')]), operation_id: 'drop' });
  const reread = await f.service.read(principal);
  assert.deepEqual(reread.trusted_origins, ['https://a.example']);
});

test('grammar and identity violations stay request-level errors without touching the source', async t => {
  const f = await fixture(t, { version: 1, trusted_origins: [] });
  const read = await f.service.read(principal);
  const base = f.ops(read.source_revision, [f.trust('https://example.com')]);
  const cases = [
    { ...base, data_id: 'foreign' }, { ...base, installation_id: 'foreign' }, { ...base, scope: 'shared' },
    { ...base, expected_revision: 'a'.repeat(64) }, { ...base, expected_resolution_revision: 'a'.repeat(64) },
    { ...identity, expected_revision: read.source_revision, expected_resolution_revision: read.source_revision },
    { ...base, operations: [] }, { ...base, operations: Array.from({ length: 17 }, () => f.trust('https://example.com')) },
    { ...base, operations: [{ op: 'trust', origin: 'https://example.com', extra: 1 }] },
    { ...base, operations: [{ op: 'trust' }] },
    { ...base, operations: [{ op: 'trust', origin: 'ftp://example.com' }] },
    { ...base, operations: [{ op: 'trust', origin: 'https://user:secret@example.com' }] },
    { ...base, operations: [{ op: 'trust', origin: 'not a url' }] },
    { ...base, operations: [{ op: 'trust', origin: `https://${'x'.repeat(301)}` }] },
    { ...base, operations: [{ op: 'trust', origin: 'https://example.com/gone' }] },
    { ...base, operations: [{ op: 'set', field: 'enabled', value: true }] },
  ];
  for (const input of cases) {
    await assert.rejects(f.service.preview(principal, input), { code: 'nnd_web_fetch_request_invalid' });
  }
  await assert.rejects(f.service.preview(readOnly, base), { code: 'integration_permission_denied' });
  const readonlyRead = await f.service.read(readOnly);
  assert.deepEqual(readonlyRead.trusted_origins, []);
  const after = await readFile(f.path, 'utf8');
  assert.equal(after, JSON.stringify({ version: 1, trusted_origins: [] }));
});

test('stale revisions conflict and replays keep their recorded receipts through the pre-read', async t => {
  const f = await fixture(t);
  const saved = await f.service.save(principal, { ...f.ops('absent', [f.trust('https://example.com')]), operation_id: 'op_a' });
  const reread = await f.service.read(principal);
  await assert.rejects(
    f.service.save(principal, { ...f.ops('absent', [f.trust('https://other.example')]), operation_id: 'stale_op' }),
    { code: 'manifest_revision_conflict' });
  assert.equal((await f.service.operation(principal, 'stale_op')) ?? null, null);
  const replayed = await f.service.save(principal, { ...f.ops('absent', [f.trust('https://example.com')]), operation_id: 'op_a' });
  assert.equal(replayed.persistence, saved.persistence);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.persisted_revision, saved.persisted_revision);
  const fresh = await f.service.save(principal, { ...f.ops(reread.source_revision, [f.trust('https://other.example')]),
    operation_id: 'op_b' });
  assert.equal(fresh.persistence, 'saved');
  const final = await f.service.read(principal);
  assert.deepEqual(final.trusted_origins, ['https://example.com', 'https://other.example']);
});

test('a corrupt or unsupported file fails closed instead of bootstrapping', async t => {
  for (const broken of [{ version: 2, trusted_origins: [] }, { version: 1, trusted_origins: ['ftp://bad.example'] }]) {
    const f = await fixture(t, broken);
    await assert.rejects(f.service.read(principal), { code: 'nnd_web_fetch_source_invalid' });
    const snapshot = await readManifestSnapshot(f.path);
    await assert.rejects(
      f.service.preview(principal, f.ops(snapshot.revision, [f.trust('https://example.com')])),
      { code: 'nnd_web_fetch_source_invalid' });
    await assert.rejects(
      f.service.save(principal, { ...f.ops(snapshot.revision, [f.trust('https://example.com')]), operation_id: 'broken_save' }),
      { code: 'nnd_web_fetch_source_invalid' });
  }
});

test('unknown raw fields survive a native save without appearing in the projection', async t => {
  const f = await fixture(t, { version: 1, trusted_origins: [], private_future_field: 'FUTURE' });
  const read = await f.service.read(principal);
  await f.service.save(principal, { ...f.ops(read.source_revision, [f.trust('https://example.com')]), operation_id: 'keep_raw' });
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.private_future_field, 'FUTURE');
  const reread = await f.service.read(principal);
  assert.equal(JSON.stringify(reread).includes('FUTURE'), false);
  assert.deepEqual(Object.keys(reread).sort(), ['application', 'data_id', 'installation_id', 'project_shadowed',
    'resolution_revision', 'scope', 'source_revision', 'source_state', 'trusted_origins', 'updated_at', 'version']);
});
