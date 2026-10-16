// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parsePublicSecret, parseAuditEvent, secretActionErrorText,
  NativeSecretActionFailure } from '../secret-actions.ts';

// The client's wire behavior lives in the page test; this unit pins the parser
// grammar and the honest export surface. The structural pin also guarantees the
// value-read consumer path never gains a client: no export couples the console
// to /use (secret.use never rides the operator principal).
const EXPORTS = ['NativeSecretActionFailure', 'SECRET_KINDS', 'SECRET_SCOPE_KINDS', 'createSecret',
  'deleteSecret', 'parseAuditEvent', 'parsePublicSecret', 'readBrokerSecrets', 'readSecretAudit', 'readSecretScopes',
  'rotateSecret', 'secretActionErrorText', 'setSecretEnabled', 'updateSecret'];

const id = 'sec_00000000-0000-4000-8000-000000000000';
const auditId = 'secret_event_00000000-0000-4000-8000-000000000000';
const stamp = '2026-10-06T16:00:00.000Z';
const secret = () => ({ id, realm: 'nna.local', label: 'Registry credential', kind: 'api_key',
  scope: null, metadata: { team: ['core', 'fringe'] }, fields: ['apikey'], enabled: true,
  createdAt: stamp, updatedAt: stamp, rotatedAt: null, lastUsedAt: null, useCount: 0 });
const audit = () => ({ format: 1, id: auditId, at: stamp, event: 'secret.created',
  outcome: 'succeeded', realm: 'nna.local', secretId: id, scope: null, consumer: null,
  destination: null, purpose: null, sessionId: null, reviewerDecisionId: null, reason: null });

describe('secret action console client', () => {
  it('pins the honest export surface: actions without any value-read consumer', async () => {
    const surface = await import('../secret-actions.ts');
    expect(Object.keys(surface).sort()).toEqual(EXPORTS);
  });
  it('parses the redacted broker roster and audit verbatim and refuses value-shaped drift', () => {
    const parsed = parsePublicSecret(secret(), 0);
    expect(parsed).toMatchObject({ label: 'Registry credential', enabled: true, useCount: 0 });
    expect(parseAuditEvent(audit(), 0)).toMatchObject({ event: 'secret.created', outcome: 'succeeded' });
    // Compatibility: SecretBroker.setEnabled(false) records secret.revoked, not secret.enabled.
    expect(parseAuditEvent({ ...audit(), event: 'secret.revoked' }, 0)).toMatchObject({ event: 'secret.revoked', outcome: 'succeeded' });
    for (const drift of [{ ...secret(), metadata: { team: { deep: 1 } } },
      { ...secret(), fields: ['bkey', 'apikey'] }, { ...secret(), fields: ['apikey', 'apikey'] },
      { ...secret(), enabled: 'yes' }, { ...secret(), realm: 'opencode.local' },
      { ...secret(), scope: { kind: 'sideways', id: 'x' } },
      { ...secret(), rotatedAt: 'yesterday' }, { ...secret(), useCount: -1 },
      { ...secret(), id: 'op_00000000-0000-4000-8000-000000000000' }]) {
      expect(() => parsePublicSecret(drift, 1)).toThrow(NativeSecretActionFailure);
    }
    for (const drift of [{ ...audit(), event: 'secret.steal' }, { ...audit(), outcome: 'maybe' },
      { ...audit(), secretId: 'op_00000000-0000-4000-8000-000000000000' }, { ...audit(), extra: 1 },
      { ...audit(), reason: 'bad\nreason' }]) {
      expect(() => parseAuditEvent(drift, 1)).toThrow(NativeSecretActionFailure);
    }
  });
  it('maps forwarded broker codes to honest sentences', () => {
    expect(secretActionErrorText('secret_label_duplicate')).toContain('already exists');
    expect(secretActionErrorText('secret_scope_forbidden')).toContain('ownership scope');
    expect(secretActionErrorText('secret_field_value_invalid')).toContain('field names and bounds');
    expect(secretActionErrorText('secret_broker_unavailable')).toContain('unavailable');
    expect(secretActionErrorText('anything')).toBe('The secret action could not be completed natively.');
  });
});
