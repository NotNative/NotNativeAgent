// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretBroker } from '../src/secret-broker.js';
import { redactText } from '../src/redaction.js';

async function fixture(realm = 'nna.local') {
  const root = await mkdtemp(join(tmpdir(), 'nna-secrets-'));
  return {
    root,
    broker: new SecretBroker({
      realm, vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson'),
    }),
  };
}

test('secret broker stores encrypted values and exposes metadata only', async () => {
  const { root, broker } = await fixture();
  const created = await broker.create({ label: 'Retail login', kind: 'username_password', fields: { username: 'me', password: 'very-secret-value' } });
  assert.deepEqual(created.fields, ['password', 'username']);
  assert.equal('password' in created, false);
  const bytes = await readFile(join(root, 'vault.json'), 'utf8');
  assert.equal(bytes.includes('very-secret-value'), false);
  assert.equal(bytes.includes('Retail login'), true);
  assert.deepEqual((await broker.list()).map((item) => item.id), [created.id]);
});

test('trusted consumer receives values transiently and exact-value redaction is active during use', async () => {
  const { broker } = await fixture();
  const created = await broker.create({ label: 'API', kind: 'api_key', fields: { api_key: 'abcd-super-secret' } });
  const result = await broker.withSecret(created.id, {
    consumer: 'test.connector', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1',
  }, async (fields) => {
    assert.equal(fields.api_key, 'abcd-super-secret');
    assert.equal(redactText('echo abcd-super-secret'), `echo [nna-redacted:${created.id}]`);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal((await broker.get(created.id)).useCount, 1);
});

test('central redaction recognizes common discovered credential representations', () => {
  const source = [
    'authtoken=discovered-token-value',
    'ngrok config add-authtoken command-token-value',
    "client --auth-token='flag-token-value'",
    'origin=https://operator:embedded-password@example.test/path',
  ].join('\n');
  const redacted = redactText(source);
  assert.match(redacted, /authtoken=\[redacted\]/u);
  assert.match(redacted, /add-authtoken \[redacted\]/u);
  assert.match(redacted, /--auth-token=\[redacted\]/u);
  assert.match(redacted, /https:\/\/operator:\[redacted\]@example\.test/u);
  assert.doesNotMatch(redacted, /discovered-token-value|command-token-value|flag-token-value|embedded-password/u);
});

test('realm separation prevents supported cross-realm enumeration and use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-realms-'));
  const paths = { vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson') };
  const local = new SecretBroker({ ...paths, realm: 'nna.local' });
  const nno = new SecretBroker({ ...paths, realm: 'nno:one' });
  const secret = await nno.create({
    label: 'Business', kind: 'token', scope: { kind: 'deployment', id: 'one' }, fields: { token: 'business-secret' },
  });
  assert.deepEqual(await local.list(), []);
  await assert.rejects(() => local.withSecret(secret.id, {
    consumer: 'test', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1',
  }, async () => undefined), { code: 'secret_not_found' });
});

test('rotation, revoke, and deletion preserve non-secret audit events', async () => {
  const { root, broker } = await fixture();
  const secret = await broker.create({ label: 'Token', kind: 'token', fields: { token: 'first-secret' } });
  await broker.rotate(secret.id, { token: 'second-secret' });
  await broker.setEnabled(secret.id, false);
  await assert.rejects(() => broker.withSecret(secret.id, {
    consumer: 'test', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1',
  }, async () => undefined), { code: 'secret_revoked' });
  await broker.remove(secret.id);
  const audit = await readFile(join(root, 'audit.ndjson'), 'utf8');
  assert.equal(audit.includes('first-secret'), false);
  assert.equal(audit.includes('second-secret'), false);
  assert.match(audit, /secret\.rotated/u);
  assert.match(audit, /secret\.revoked/u);
});

test('authenticated encryption binds ciphertext to its record metadata', async () => {
  const { broker } = await fixture();
  const first = await broker.create({ label: 'One', kind: 'token', fields: { token: 'secret-one' } });
  const second = await broker.create({ label: 'Two', kind: 'token', fields: { token: 'secret-two' } });
  await broker.vault.update((vault) => {
    const left = vault.records.find((item) => item.id === first.id);
    const right = vault.records.find((item) => item.id === second.id);
    left.encryptedFields.token = right.encryptedFields.token;
    return vault;
  });
  await assert.rejects(() => broker.withSecret(first.id, {
    consumer: 'test', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1',
  }, async () => undefined), { code: 'secret_vault_integrity_failed' });
});

test('durable secret mutations succeed when audit observation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-audit-failure-'));
  const broker = new SecretBroker({
    vaultPath: join(root, 'vault.json'),
    keyPath: join(root, 'key.json'),
    audit: async () => { throw Object.assign(new Error('observer unavailable'), { code: 'observer_unavailable' }); },
  });
  const created = await broker.create({ label: 'Still durable', kind: 'token', fields: { token: 'durable-secret' } });
  assert.equal((await broker.get(created.id)).label, 'Still durable');
  assert.equal(broker.lastAuditFailure, 'observer_unavailable');
});

test('audit reads skip malformed ledger lines while retaining valid events', async () => {
  const { root, broker } = await fixture();
  await broker.create({ label: 'Audited', kind: 'token', fields: { token: 'audit-secret' } });
  await appendFile(join(root, 'audit.ndjson'), '{malformed-json}\n', 'utf8');
  const events = await broker.auditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'secret.created');
});
