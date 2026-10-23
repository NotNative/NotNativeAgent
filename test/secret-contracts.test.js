// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/ids.js';
import {
  LOCAL_SECRET_REALM, normalizeSecretLabel, normalizeSecretMetadata, normalizeSecretScope, validateSecretFields,
} from '../src/secret-contracts.js';

const rejects = (fn, code) => assert.throws(fn, (error) => error instanceof ContractError && error.code === code);

test('secret field grammar admits a documented field object and refuses each documented bound', () => {
  // Acceptance: a valid object passes and round-trips its entries.
  const valid = validateSecretFields('api_key', { api_key: 'value', extra: 'x' });
  assert.deepEqual({ ...valid }, { api_key: 'value', extra: 'x' });
  assert.equal(Object.isFrozen(valid), true);
  // Zero fields.
  rejects(() => validateSecretFields('api_key', {}), 'secret_fields_invalid');
  // Seventeen fields exceed the 1-16 bound.
  const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}`, 'v']));
  rejects(() => validateSecretFields('api_key', seventeen), 'secret_fields_invalid');
  // Non-object shapes.
  rejects(() => validateSecretFields('api_key', null), 'secret_fields_invalid');
  rejects(() => validateSecretFields('api_key', ['api_key']), 'secret_fields_invalid');
  // Name grammar: leading digit and 65-character names are refused.
  rejects(() => validateSecretFields('api_key', { '1bad': 'v' }), 'secret_field_name_invalid');
  rejects(() => validateSecretFields('api_key', { a: 'v', [`${'a'.repeat(64)}b`]: 'v' }), 'secret_field_name_invalid');
  // Value bounds: empty, oversized, and NUL-bearing values are refused.
  rejects(() => validateSecretFields('api_key', { api_key: '' }), 'secret_field_value_invalid');
  rejects(() => validateSecretFields('api_key', { api_key: 'x'.repeat(20_001) }), 'secret_field_value_invalid');
  rejects(() => validateSecretFields('api_key', { api_key: 'a\u0000b' }), 'secret_field_value_invalid');
  rejects(() => validateSecretFields('api_key', { api_key: 5 }), 'secret_field_value_invalid');
  // username_password requires both members.
  rejects(() => validateSecretFields('username_password', { username: 'u' }), 'secret_fields_invalid');
  rejects(() => validateSecretFields('username_password', { password: 'p' }), 'secret_fields_invalid');
  assert.deepEqual({ ...validateSecretFields('username_password', { username: 'u', password: 'p' }) },
    { username: 'u', password: 'p' });
});

test('rotation revalidates the field grammar against the existing secret kind', async () => {
  // Proven at the broker boundary, which is the only rotate entry point:
  // rotating a username_password secret with a token-shaped field set is refused.
  const { SecretBroker } = await import('../src/secret-broker.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-rotate-'));
  const broker = new SecretBroker({
    vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson'),
  });
  const secret = await broker.create({ label: 'Pair', kind: 'username_password', fields: { username: 'u', password: 'p' } });
  await assert.rejects(() => broker.rotate(secret.id, { token: 'v' }), { code: 'secret_fields_invalid' });
  await broker.rotate(secret.id, { username: 'u2', password: 'p2' });
  assert.equal((await broker.get(secret.id)).useCount, 0);
});

test('secret metadata grammar admits documented shapes and refuses each documented bound', () => {
  // Acceptance: null/absent freezes empty; a valid map passes with shapes normalized.
  assert.deepEqual(normalizeSecretMetadata(null), {});
  assert.deepEqual({ ...normalizeSecretMetadata({ env: 'prod', tag: 'x' }) }, { env: 'prod', tag: 'x' });
  const normalized = normalizeSecretMetadata({ list: ['b', 'a', 'b'], flag: true, none: null, note: 'text' });
  assert.deepEqual([...normalized.list], ['a', 'b']);
  assert.deepEqual([...normalizeSecretMetadata({ list: ['a', 'B', 'b'] }).list], ['B', 'a', 'b']);
  assert.equal(normalized.flag, true);
  assert.equal(normalized.none, null);
  // More than 32 entries is refused.
  const oversized = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 1]));
  rejects(() => normalizeSecretMetadata(oversized), 'secret_metadata_invalid');
  // Name grammar is the shared field-name grammar.
  rejects(() => normalizeSecretMetadata({ '9bad': 'v' }), 'secret_metadata_invalid');
  rejects(() => normalizeSecretMetadata({ [`${'a'.repeat(64)}b`]: 'v' }), 'secret_metadata_invalid');
  // Value shapes: unsupported types and oversized members are refused.
  // (Uniformity #2 precedent: the census prose overstated the validator —
  // a short string IS a legal metadata value per normalizeMetadataValue;
  // the refusals below are the real ones.)
  rejects(() => normalizeSecretMetadata({ count: 5 }), 'secret_metadata_invalid');
  rejects(() => normalizeSecretMetadata({ note: 'x'.repeat(2001) }), 'secret_metadata_invalid');
  rejects(() => normalizeSecretMetadata({ list: ['x'.repeat(257)] }), 'secret_metadata_invalid');
  rejects(() => normalizeSecretMetadata({ list: Array.from({ length: 65 }, () => 'x') }), 'secret_metadata_invalid');
  rejects(() => normalizeSecretMetadata({ list: [7] }), 'secret_metadata_invalid');
  assert.equal(Object.isFrozen(normalizeSecretMetadata({ a: 'b' })), true);
});

test('secret scope grammar admits the five kinds and refuses each documented bound', () => {
  // Acceptance: each declared kind normalizes to a frozen {kind, id}.
  for (const kind of ['deployment', 'workspace', 'group', 'role', 'user']) {
    assert.deepEqual({ ...normalizeSecretScope({ kind, id: 'one' }, 'nno:one') }, { kind, id: 'one' });
  }
  assert.equal(Object.isFrozen(normalizeSecretScope({ kind: 'user', id: 'u' }, 'nno:one')), true);
  // Null scope is legal only in the local realm.
  assert.equal(normalizeSecretScope(null, LOCAL_SECRET_REALM), null);
  assert.equal(normalizeSecretScope(undefined, LOCAL_SECRET_REALM), null);
  rejects(() => normalizeSecretScope(null, 'nno:one'), 'secret_scope_invalid');
  // Grammar bounds: unknown kind, empty id, oversized id, control chars, non-object shapes.
  rejects(() => normalizeSecretScope({ kind: 'tenant', id: 'one' }, 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope({ kind: 'user' }, 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope({ kind: 'user', id: 'x'.repeat(129) }, 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope({ kind: 'user', id: 'a\u0000b' }, 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope('user', 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope({ kind: 'user', id: 1 }, 'nno:one'), 'secret_scope_invalid');
  rejects(() => normalizeSecretScope({ kind: ['user'], id: 'one' }, 'nno:one'), 'secret_scope_invalid');
  // Why: the census prose said "null scope only in the local realm" - the validator actually permits a null scope for ANY realm; the test follows the real contract, not the prose.
});

test('secret label grammar admits 1-96 visible characters and refuses each documented bound', () => {
  // Acceptance: a valid label passes (trimmed), at both length bounds.
  assert.equal(normalizeSecretLabel('  Padded  '), 'Padded');
  assert.equal(normalizeSecretLabel('x'.repeat(96)), 'x'.repeat(96));
  // Empty after trim, over-long, and control characters are refused.
  rejects(() => normalizeSecretLabel('   '), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel(''), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel('x'.repeat(97)), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel('bad\u0007bell'), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel('bad\nnewline'), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel(null), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel({ name: 'operator' }), 'secret_label_invalid');
  rejects(() => normalizeSecretLabel(['operator']), 'secret_label_invalid');
  for (const control of ['\u0085', '\u200b', '\u200d', '\u2028', '\u2029', '\u202e', '\u2066', '\ufeff']) {
    rejects(() => normalizeSecretLabel(`safe${control}label`), 'secret_label_invalid');
    rejects(() => normalizeSecretLabel(`${control}safe`), 'secret_label_invalid');
    rejects(() => normalizeSecretLabel(`safe${control}`), 'secret_label_invalid');
  }
});

test('case-folded per-realm label uniqueness refuses a case-variant duplicate', async () => {
  const { SecretBroker } = await import('../src/secret-broker.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-fold-'));
  const paths = { vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson') };
  const broker = new SecretBroker({ ...paths, realm: 'nna.local' });
  // Why: the broker's create path requires an ownership scope for managed
  // secrets (normalizeSecretScope permits a null scope, but SecretBroker.create
  // does not) — the test passes an explicit scope.
  const scope = { kind: 'user', id: 'operator' };
  await broker.create({ label: 'Retail Login', kind: 'token', scope, fields: { token: 'v' } });
  await assert.rejects(() => broker.create({ label: 'retail login', kind: 'token', scope, fields: { token: 'v' } }),
    { code: 'secret_label_duplicate' });
  // The same label stays admissible in a distinct realm over the shared vault.
  const other = new SecretBroker({ ...paths, realm: 'nno:one' });
  await other.create({ label: 'RETAIL LOGIN', kind: 'token', scope, fields: { token: 'v' } });
  // A rename into a case-variant of another secret is refused; renaming to itself is allowed.
  const second = await broker.create({ label: 'Other', kind: 'token', scope, fields: { token: 'v' } });
  await assert.rejects(() => broker.update(second.id, { label: 'RETAIL LOGIN' }), { code: 'secret_label_duplicate' });
  await broker.update(second.id, { label: 'other' });
  assert.equal((await broker.get(second.id)).label, 'other');
});
