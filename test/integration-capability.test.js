// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityAuthority } from '../src/integration-capability.js';
import { encodeCapabilityToken, verifyCapabilityToken } from '../src/capability-token.js';

const PRINCIPAL = Object.freeze({
  subject_id: 'nnd-service:nna_test', platform_role: 'service',
  permissions: ['harness.proxy', 'secret.scope.deployment'],
  workspace_ids: ['ws_1'], group_ids: [],
});
let tick = 1_000_000;
const clock = () => tick;
const authority = () => createCapabilityAuthority({
  generation: 'gen_1', principal: PRINCIPAL, key: 'k'.repeat(43), keyId: 'cap_test',
  ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: clock,
});
const throwsCode = (fn, code) => assert.throws(fn, (error) => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return true;
});

test('issued capability verifies and carries exactly the issued authority', () => {
  const cap = authority();
  const token = cap.issue();
  const verified = cap.verify(token);
  assert.equal(verified.subjectId, PRINCIPAL.subject_id);
  assert.deepEqual(verified.permissions, [...PRINCIPAL.permissions].sort());
  assert.deepEqual(verified.workspaceIds, ['ws_1']);
  assert.equal(verified.expiresAt - verified.issuedAt, 600_000);
});

test('issued authority is a snapshot of the validated principal', () => {
  const principal = {
    ...PRINCIPAL, permissions: [...PRINCIPAL.permissions], workspace_ids: ['ws_1'], group_ids: [],
  };
  const cap = createCapabilityAuthority({
    generation: 'gen_1', principal, key: 'k'.repeat(43), keyId: 'cap_test',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: () => 1_000_000,
  });
  principal.subject_id = 'other';
  principal.permissions.push('*');
  principal.workspace_ids[0] = 'ws_other';
  const token = cap.issue();
  const verified = cap.verify(token);
  assert.equal(verified.subjectId, PRINCIPAL.subject_id);
  assert.deepEqual(verified.permissions, [...PRINCIPAL.permissions].sort());
  assert.deepEqual(verified.workspaceIds, ['ws_1']);
  assert.deepEqual(cap.verify(cap.renew(token)).permissions, [...PRINCIPAL.permissions].sort());
});

test('expired capability fails closed beyond grace but renews within it', () => {
  const cap = authority();
  const token = cap.issue();
  tick += 600_000 + 30_000; // inside the 60s grace window
  assert.equal(cap.verify(token).subjectId, PRINCIPAL.subject_id);
  const renewed = cap.renew(token);
  assert.equal(cap.verify(renewed).keyId, 'cap_test');
  tick += 700_000; // beyond grace
  throwsCode(() => cap.verify(token), 'capability_expired');
  throwsCode(() => cap.renew(token), 'capability_expired');
});

test('renewal preserves authority and rejects a forged authority change', () => {
  const cap = authority();
  const token = cap.issue();
  const renewed = cap.renew(token);
  const verified = cap.verify(renewed);
  assert.deepEqual(verified.permissions, [...PRINCIPAL.permissions].sort());
  // A caller cannot broaden authority: renewal derives from the previous
  // capability, so tampering with the payload breaks the signature instead.
  const [payload] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')),
    permissions: ['*'] })).toString('base64url');
  throwsCode(() => cap.verify(`${forged}.${token.split('.')[1]}`), 'capability_invalid');
});

test('revocation takes effect immediately and survives rotation semantics', () => {
  const cap = authority();
  const token = cap.issue();
  cap.revoke();
  throwsCode(() => cap.verify(token), 'capability_revoked');
  throwsCode(() => cap.issue(), 'capability_revoked');
  cap.rotate();
  throwsCode(() => cap.renew(token), 'capability_invalid');
  const fresh = cap.issue();
  assert.equal(cap.verify(fresh).keyId, cap.keyId);
});

test('authority construction bounds keys, key IDs, generation and durations', () => {
  const options = { generation: ' gen_1 ', principal: PRINCIPAL, key: 'k'.repeat(43),
    keyId: ' cap_test ', now: () => 1_000_000 };
  const cap = createCapabilityAuthority(options);
  assert.equal(cap.keyId, 'cap_test');
  assert.equal(cap.verify(cap.issue()).keyId, 'cap_test');
  for (const override of [{ key: 'short' }, { key: '' }, { key: null },
    { key: 'k'.repeat(4097) }, { keyId: '' }, { keyId: 'bad\nkey' },
    { generation: ' '.repeat(4) }, { ttlMs: 0 }, { ttlMs: 86_400_001 },
    { graceMs: 600_000 }, { graceMs: -1 }, { skewMs: 300_001 }]) {
    throwsCode(() => createCapabilityAuthority({ ...options, ...override }), 'capability_invalid');
  }
});

test('caller-owned signing key buffers cannot change an issued authority', () => {
  const key = Buffer.alloc(32, 0x6b);
  const cap = createCapabilityAuthority({
    generation: 'gen_1', principal: PRINCIPAL, key, keyId: 'cap_test', now: () => 1_000_000,
  });
  const token = cap.issue();
  key.fill(0); // A caller can wipe its copy without revoking or changing the authority.
  assert.equal(cap.verify(token).subjectId, PRINCIPAL.subject_id);
  assert.equal(cap.verify(cap.issue()).subjectId, PRINCIPAL.subject_id);
});

test('short-lived capabilities may retain a separately bounded renewal grace', () => {
  const cap = createCapabilityAuthority({
    generation: 'gen_1', principal: PRINCIPAL, key: 'k'.repeat(43), keyId: 'cap_test',
    ttlMs: 30_000, now: () => 1_000_000,
  });
  const verified = cap.verify(cap.issue());
  assert.equal(verified.expiresAt - verified.issuedAt, 30_000);
});

test('deferred generation binding stores the normalized value', () => {
  const cap = createCapabilityAuthority({ generation: undefined, principal: PRINCIPAL,
    key: 'k'.repeat(43), keyId: 'cap_test', now: () => 1_000_000 });
  cap.bind(' gen_1 ');
  const token = cap.issue();
  assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).generation, 'gen_1');
  assert.equal(cap.verify(token).subjectId, PRINCIPAL.subject_id);
});

test('unknown keys fail closed without disclosing key state before signature verification', () => {
  const cap = authority();
  const foreign = createCapabilityAuthority({
    generation: 'gen_1', principal: PRINCIPAL, key: 'j'.repeat(43), keyId: 'cap_other',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: clock,
  });
  throwsCode(() => cap.verify(foreign.issue()), 'capability_invalid');
});

test('unsigned key lifecycle claims do not reveal revocation or rotation state', () => {
  const cap = authority();
  const token = cap.issue();
  const [payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  for (const keyId of ['cap_other', 'cap_test']) {
    const tampered = Buffer.from(JSON.stringify({ ...claims, key_id: keyId,
      subject_id: 'unsigned-tamper' })).toString('base64url');
    cap.revoke();
    throwsCode(() => cap.verify(`${tampered}.${signature}`), 'capability_invalid');
  }
});

test('capability version cannot be overridden by an encoder caller', () => {
  const encoded = encodeCapabilityToken({ v: 99, scope: 'nnd-service' }, 'k'.repeat(43));
  assert.equal(JSON.parse(Buffer.from(encoded.split('.')[0], 'base64url').toString('utf8')).v, 1);
});

test('generation and scope bind the capability to one supervised service', () => {
  const cap = authority();
  const token = cap.issue();
  const other = createCapabilityAuthority({
    generation: 'gen_2', principal: PRINCIPAL, key: 'k'.repeat(43), keyId: 'cap_test',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: clock,
  });
  throwsCode(() => other.verify(token), 'capability_invalid');
});

test('clock skew is bounded in both directions', () => {
  let now = 1_000_000;
  const cap = createCapabilityAuthority({
    generation: 'gen_1', principal: PRINCIPAL, key: 'k'.repeat(43), keyId: 'cap_test',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: () => now,
  });
  const token = cap.issue();
  now -= 31_000; // issued_at in the future beyond skew
  throwsCode(() => cap.verify(token), 'capability_skew');
  now = 1_000_000 - 20_000; // within skew
  assert.equal(cap.verify(token).subjectId, PRINCIPAL.subject_id);
});

test('invalid clock values and duration bounds never admit a capability', () => {
  let now = 1_000_000;
  const options = {
    generation: 'gen_1', principal: PRINCIPAL, key: 'k'.repeat(43), keyId: 'cap_test',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: () => now,
  };
  for (const override of [{ ttlMs: NaN }, { ttlMs: 0 }, { graceMs: NaN },
    { graceMs: -1 }, { skewMs: Infinity }, { skewMs: -1 }, { now: null }]) {
    throwsCode(() => createCapabilityAuthority({ ...options, ...override }), 'capability_invalid');
  }
  const cap = createCapabilityAuthority(options);
  const token = cap.issue();
  now = NaN;
  throwsCode(() => cap.verify(token), 'capability_invalid');
  throwsCode(() => cap.renew(token), 'capability_invalid');
  throwsCode(() => cap.issue(), 'capability_invalid');
  now = Infinity;
  throwsCode(() => cap.verify(token), 'capability_invalid');
  now = 1_000_000;
  const context = {
    boundGeneration: 'gen_1', activeKey: options.key, activeKeyId: 'cap_test',
    revoked: new Set(), now: () => now, graceMs: 60_000, allowGrace: true,
  };
  throwsCode(() => verifyCapabilityToken(token, context), 'capability_invalid');
  throwsCode(() => verifyCapabilityToken(token, undefined), 'capability_invalid');
  throwsCode(() => verifyCapabilityToken(token, { ...context, skewMs: 0, revoked: null }), 'capability_invalid');
  throwsCode(() => verifyCapabilityToken(token, { ...context, skewMs: 0, activeKey: null }), 'capability_invalid');
  now = 1_000_000 + 600_000 + 60_001;
  throwsCode(() => cap.verify(token), 'capability_expired');
});

test('malformed tokens and invalid principals fail closed', () => {
  const cap = authority();
  throwsCode(() => cap.verify('not-a-token'), 'capability_invalid');
  throwsCode(() => cap.verify(`${'A'.repeat(64)}.${'B'.repeat(64)}`), 'capability_invalid');
  throwsCode(() => createCapabilityAuthority({ generation: 'g', principal: { ...PRINCIPAL, subject_id: '' },
    now: clock }), 'capability_invalid');
  throwsCode(() => createCapabilityAuthority({ generation: 'g', principal: { ...PRINCIPAL, permissions: 'all' },
    now: clock }), 'capability_invalid');
});
