// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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

test('competing secret creators share one fully published key and retain readable values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-key-race-'));
  const paths = { vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') };
  const brokers = Array.from({ length: 8 }, () => new SecretBroker(paths));
  const created = await Promise.all(brokers.map((broker, index) => broker.create({
    label: `Concurrent ${index}`, kind: 'token', fields: { token: `value-${index}` },
  })));
  for (const [index, secret] of created.entries()) {
    const value = await brokers[index].withSecret(secret.id, {
      consumer: 'test', destination: 'https://example.test', purpose: 'verify', reviewerDecisionId: 'review_1',
    }, async (fields) => fields.token);
    assert.equal(value, `value-${index}`);
  }
  assert.equal((await readdir(root)).some((name) => name.startsWith('key.json.tmp-')), false);
  const keyPath = join(root, 'key.json');
  await writeFile(keyPath, '{malformed', 'utf8');
  await assert.rejects(() => brokers[0].rotate(created[0].id, { token: 'replacement' }), { code: 'secret_key_invalid' });
  assert.equal(await readFile(keyPath, 'utf8'), '{malformed');
});

test('missing key cannot be replaced while encrypted vault records remain', async () => {
  const { root, broker } = await fixture();
  const created = await broker.create({ label: 'Kept', kind: 'token', fields: { token: 'original' } });
  const keyPath = join(root, 'key.json');
  await unlink(keyPath);
  await assert.rejects(() => broker.create({ label: 'Another', kind: 'token', fields: { token: 'new' } }), {
    code: 'secret_key_invalid',
  });
  await assert.rejects(() => broker.withSecret(created.id, {
    consumer: 'test', destination: 'https://example.test', purpose: 'verify', reviewerDecisionId: 'review_1',
  }, async (fields) => fields.token), { code: 'secret_key_invalid' });
  await assert.rejects(() => readFile(keyPath, 'utf8'), { code: 'ENOENT' });
});

test('malformed stored metadata cannot reach a public secret projection', async () => {
  const { root, broker } = await fixture();
  await broker.create({ label: 'Stored', kind: 'token', fields: { token: 'private' },
    metadata: { tags: ['safe'] } });
  const vaultPath = join(root, 'vault.json');
  const vault = JSON.parse(await readFile(vaultPath, 'utf8'));
  for (const metadata of [{ nested: { credential: 'private' } }, { tags: [{ credential: 'private' }] }]) {
    vault.records[0].metadata = metadata;
    await writeFile(vaultPath, JSON.stringify(vault));
    await assert.rejects(() => broker.list(), { code: 'secret_vault_corrupt' });
  }
});

test('malformed stored managed scope fails closed before authorization and projection', async () => {
  const { root, broker } = await fixture();
  await broker.create({ label: 'Stored', kind: 'token', fields: { token: 'private' } });
  const vaultPath = join(root, 'vault.json');
  const vault = JSON.parse(await readFile(vaultPath, 'utf8'));
  vault.records[0].realm = 'nno:one';
  vault.records[0].scope = { kind: 'user', id: { nested: 'private' } };
  await writeFile(vaultPath, JSON.stringify(vault));
  await assert.rejects(() => broker.list(), { code: 'secret_vault_corrupt' });
});

test('malformed stored encrypted fields and identities fail as vault corruption before use', async () => {
  const { root, broker } = await fixture();
  const secret = await broker.create({ label: 'Stored', kind: 'token', fields: { token: 'private' } });
  const vaultPath = join(root, 'vault.json');
  const original = JSON.parse(await readFile(vaultPath, 'utf8'));
  const request = { consumer: 'test', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1' };
  const malformed = [
    (record) => { record.encryptedFields.token = null; },
    (record) => { record.encryptedFields.token = 'ciphertext'; },
    (record) => { record.encryptedFields.token.keyVersion = null; },
    (record) => { record.encryptedFields['bad field'] = record.encryptedFields.token; },
    (record) => { record.encryptedFields = {}; },
    (record) => { record.id = { nested: 'id' }; },
    (record) => { record.realm = { nested: 'realm' }; },
    (record) => { record.label = { nested: 'label' }; },
    (record) => { record.enabled = 'true'; },
    (record) => { record.useCount = -1; },
    (record) => { record.createdAt = { nested: 'private' }; },
    (record) => { record.updatedAt = '2026-02-30T00:00:00.000Z'; },
    (record) => { record.rotatedAt = { nested: 'private' }; },
    (record) => { record.lastUsedAt = 'yesterday'; },
  ];
  for (const damage of malformed) {
    const vault = structuredClone(original);
    damage(vault.records[0]);
    await writeFile(vaultPath, JSON.stringify(vault));
    await assert.rejects(() => broker.list(), { code: 'secret_vault_corrupt' });
    await assert.rejects(() => broker.withSecret(secret.id, request, async () => undefined), { code: 'secret_vault_corrupt' });
    await assert.rejects(() => broker.vault.decryptFields(vault.records[0]), { code: 'secret_vault_corrupt' });
  }
});

test('duplicate vault IDs fail on read and update across realms', async () => {
  const { root, broker } = await fixture();
  const secret = await broker.create({ label: 'Stored', kind: 'token', fields: { token: 'private' } });
  const vaultPath = join(root, 'vault.json');
  const original = JSON.parse(await readFile(vaultPath, 'utf8'));
  const duplicate = structuredClone(original.records[0]);
  duplicate.label = 'Other';
  await assert.rejects(() => broker.vault.update((vault) => {
    vault.records.push(duplicate);
    return vault;
  }), { code: 'secret_vault_corrupt' });
  assert.equal((await broker.get(secret.id)).label, 'Stored');
  duplicate.realm = 'nno:other';
  duplicate.scope = { kind: 'user', id: 'operator' };
  original.records.push(duplicate);
  await writeFile(vaultPath, JSON.stringify(original));
  await assert.rejects(() => broker.list(), { code: 'secret_vault_corrupt' });
  await assert.rejects(() => broker.withSecret(secret.id, {
    consumer: 'test', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1',
  }, async () => undefined), { code: 'secret_vault_corrupt' });
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

test('central redaction preserves recognizable source-code expressions after sensitive labels', () => {
  const source = 'const policy = { secret: Object.freeze({ category: "credential" }), token: process.env.RUNTIME_TOKEN };';
  assert.equal(redactText(source), source);
  assert.equal(redactText('secret: "literal-value"'), 'secret: [redacted]');
  for (const exposed of [
    'password: {value:"hunter2"}', 'api_key: atob("c2stYWJj")',
    'token: cfg["prod"]', 'secret: req.headers["x"]',
  ]) {
    assert.doesNotMatch(redactText(exposed), /hunter2|c2stYWJj|cfg\[|req\.headers/u);
  }
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

test('secret use requires the four-field envelope of non-empty strings', async () => {
  const { broker } = await fixture();
  const created = await broker.create({ label: 'Envelope', kind: 'token', fields: { token: 'envelope-secret' } });
  const valid = { consumer: 'test.connector', destination: 'https://example.test', purpose: 'test', reviewerDecisionId: 'review_1' };
  for (const key of ['consumer', 'destination', 'purpose', 'reviewerDecisionId']) {
    const missing = { ...valid, [key]: undefined };
    await assert.rejects(() => broker.withSecret(created.id, missing, async () => undefined),
      { code: 'secret_use_request_invalid' });
    const empty = { ...valid, [key]: '   ' };
    await assert.rejects(() => broker.withSecret(created.id, empty, async () => undefined),
      { code: 'secret_use_request_invalid' });
  }
  await assert.rejects(() => broker.withSecret(created.id, null, async () => undefined),
    { code: 'secret_use_request_invalid' });
  assert.equal((await broker.get(created.id)).useCount, 0);
  const result = await broker.withSecret(created.id, valid, async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal((await broker.get(created.id)).useCount, 1);
});

test('audit reads skip malformed ledger lines while retaining valid events', async () => {
  const { root, broker } = await fixture();
  await broker.create({ label: 'Audited', kind: 'token', fields: { token: 'audit-secret' } });
  await appendFile(join(root, 'audit.ndjson'), '{malformed-json}\n', 'utf8');
  const events = await broker.auditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'secret.created');
});
