// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseNativeSecretsCatalog, parseNativeSecretsList, NativeSecretsFailure,
  secretsErrorText } from '../secrets.ts';

const record = () => ({ id: 'sec_00000000-0000-4000-8000-000000000000', realm: 'nna.local',
  label: 'Registry credential', kind: 'api_key', scope: null,
  metadata: { team: ['core', 'fringe'], region: 'eu-1' }, fields: ['apikey'], enabled: true,
  created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z',
  rotated_at: null, last_used_at: null, use_count: 0 });
const list = (records: unknown[], absent = false) => ({ schema_version: '1.0', installation_id: 'install_secrets',
  data_id: 'data_secrets', scope: 'user', source_state: absent ? 'absent' : 'present',
  count: records.length, secrets: records, application: 'next_secret_use' });
const catalog = () => ({ schema_version: '1.0', source: 'secrets', scope: 'user',
  fields: ['label', 'kind', 'scope', 'metadata.{name}', 'fields.{field}', 'enabled'].map(path => ({
    path, classification: 'operator_setting', application: 'next_secret_use', scope: 'user',
    required_permission: 'nnd.configuration.read',
    editability: { available: false, scope: 'user', reason: 'secret_broker_actions' } })) });

describe('native secrets list parser', () => {
  it('accepts the actual native projector envelope instead of a separately invented response shape', async () => {
    const native = await import(new URL('../../../../../../../src/nnd-secrets-routes.js', import.meta.url).href);
    const projected = native.projectSecretsList({ installationId: 'install_secrets', dataId: 'data_secrets', sourceState: 'present', count: 0, records: [] });
    expect(parseNativeSecretsList(projected)).toMatchObject({ schema_version: '1.0', source_state: 'present', count: 0 });
  });
  it('presents the redaction-safe roster: absent is empty, present carries field names only', () => {
    expect(parseNativeSecretsList(list([], true))).toMatchObject({ count: 0, source_state: 'absent' });
    const projected = parseNativeSecretsList(list([record()]));
    expect(projected.secrets[0]).toMatchObject({ label: 'Registry credential', kind: 'api_key',
      scope: null, fields: ['apikey'], enabled: true, use_count: 0 });
    expect(JSON.stringify(projected.secrets[0])).not.toContain('ciphertext');
    expect(JSON.stringify(projected)).not.toContain('nonce');
  });
  it('refuses drifted envelopes and records', () => {
    const refusal = (raw: unknown) => expect(() => parseNativeSecretsList(raw)).toThrow(NativeSecretsFailure);
    refusal({ ...list([], true), count: 1 });
    refusal({ ...list([], true), application: 'next_service_start' });
    refusal({ ...list([], true), extra: 1 });
    refusal({ ...list([], true), schema_version: undefined });
    refusal({ ...list([record()]), source_state: 'absent' });
    refusal({ ...list([record()]), secrets: [{ ...record(), realm: 'opencode.local' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), id: 'not_sec' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), kind: 'other' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), fields: ['bkey', 'apikey'] }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), fields: ['apikey', 'apikey'] }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), metadata: { team: ['zulu', 'alpha'] } }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), enabled: 'yes' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), created_at: 'yesterday' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), use_count: -1 }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), scope: { kind: 'other', id: 'x' } }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), label: '' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), label: 'x'.repeat(97) }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), label: 'bad\nline' }] });
    refusal({ ...list([record()]), secrets: [{ ...record(), metadata: { 'BAD NAME': ['core', 'fringe'] } }] });
  });
});

describe('native secrets catalog parser', () => {
  it('pins the six read-only fields and refuses drift', () => {
    const parsed = parseNativeSecretsCatalog(catalog());
    expect(parsed.fields.map(field => field.path)).toEqual(['label', 'kind', 'scope',
      'metadata.{name}', 'fields.{field}', 'enabled']);
    const modified = catalog() as { fields: Record<string, unknown>[] };
    modified.fields[2]!.editability = { available: true, scope: 'user', reason: 'x' };
    expect(() => parseNativeSecretsCatalog(modified)).toThrow(NativeSecretsFailure);
    const dropped = catalog() as { fields: unknown[] };
    dropped.fields.pop();
    expect(() => parseNativeSecretsCatalog(dropped)).toThrow(NativeSecretsFailure);
  });
});

describe('honest failure sentences', () => {
  it('maps vault damage to a repair sentence and keeps unknown codes generic', () => {
    expect(secretsErrorText('secret_vault_corrupt')).toContain('needs native repair');
    expect(secretsErrorText('secret_key_invalid')).toContain('needs native repair');
    expect(secretsErrorText('nnd_secrets_unsupported')).toContain('does not expose');
    expect(secretsErrorText('everything_else')).toBe('Secrets metadata could not be read.');
  });
});
