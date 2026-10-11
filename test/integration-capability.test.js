// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityAuthority } from '../src/integration-capability.js';

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
  cap.rotate();
  throwsCode(() => cap.renew(token), 'capability_revoked');
  const fresh = cap.issue();
  assert.equal(cap.verify(fresh).keyId, cap.keyId);
});

test('unknown keys fail closed as restart evidence, not as revoked state', () => {
  const cap = authority();
  const foreign = createCapabilityAuthority({
    generation: 'gen_1', principal: PRINCIPAL, key: 'j'.repeat(43), keyId: 'cap_other',
    ttlMs: 600_000, graceMs: 60_000, skewMs: 30_000, now: clock,
  });
  throwsCode(() => cap.verify(foreign.issue()), 'capability_key_unknown');
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

test('malformed tokens and invalid principals fail closed', () => {
  const cap = authority();
  throwsCode(() => cap.verify('not-a-token'), 'capability_invalid');
  throwsCode(() => cap.verify(`${'A'.repeat(64)}.${'B'.repeat(64)}`), 'capability_invalid');
  throwsCode(() => createCapabilityAuthority({ generation: 'g', principal: { ...PRINCIPAL, subject_id: '' },
    now: clock }), 'capability_invalid');
  throwsCode(() => createCapabilityAuthority({ generation: 'g', principal: { ...PRINCIPAL, permissions: 'all' },
    now: clock }), 'capability_invalid');
});
