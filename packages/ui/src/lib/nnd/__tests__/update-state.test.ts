// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { parseNativeUpdateStateView, parseNativeUpdateStateCatalog } from '../update-state.ts';

const identity = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user' };
const SHA = 'a'.repeat(40);
const recorded = { ...identity, schema_version: '1.0', state: 'recorded', format: 1,
  checked_at: '2026-10-06T01:02:03.004Z', status: 'ready', latest_version: '20261007-1',
  latest_ref: 'main', latest_tag: null, latest_sha: SHA, error_code: null };
const catalog = () => ({ schema_version: '1.0', source: 'update_state', scope: 'user',
  fields: ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag',
    'latest_sha', 'error_code'].map((path) => ({ path, classification: 'generated_state',
    application: 'next_update_check', editability: { available: false, scope: 'user',
    reason: 'generated_state' } })) });

it('update-state parser rebuilds absence, records, and catalog exactly as served', () => {
  const absent = parseNativeUpdateStateView({ ...identity, schema_version: '1.0', state: 'absent' });
  expect(Object.keys(absent)).toEqual(['schema_version', 'installation_id', 'data_id', 'scope', 'state']);
  expect(absent.state).toBe('absent');
  const parsed = parseNativeUpdateStateView({ ...recorded, installed_at: '2026-10-06T02:00:00Z' });
  expect(Object.keys(parsed)).toEqual(['schema_version', 'installation_id', 'data_id', 'scope', 'state',
    'format', 'status', 'checked_at', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code']);
  expect(parsed.latest_version).toBe('20261007-1');
  expect(JSON.stringify(parsed).includes('installed_at')).toBe(false);
  const unavailable = parseNativeUpdateStateView({ ...recorded, status: 'unavailable', latest_version: null,
    latest_sha: null, error_code: 'update_check_timeout' });
  expect(unavailable.error_code).toBe('update_check_timeout');
  // Store-grammar parity: the native validator accepts v-prefixed or long-sequence
  // versions, offset timestamps, and punctuation-bearing brief values.
  expect(parseNativeUpdateStateView({ ...recorded, latest_version: 'v20261007-1' }).latest_version)
    .toBe('v20261007-1');
  expect(parseNativeUpdateStateView({ ...recorded, checked_at: '2026-10-06T01:02:03+02:00' }).checked_at)
    .toBe('2026-10-06T01:02:03+02:00');
  expect(Object.keys(parseNativeUpdateStateCatalog(catalog())).map((key) => key === 'fields' ? 'fields' : key))
    .toEqual(['schema_version', 'source', 'scope', 'fields']);
  expect(parseNativeUpdateStateCatalog(catalog()).fields.map((field) => field.path)).toEqual(
    ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code']);
});

it('update-state parser refuses offline-detection drift and invented records', () => {
  const hostile = [
    { ...identity, schema_version: '1.0', state: 'guessed' },
    { ...identity, schema_version: '2.0', state: 'absent' },
    { ...recorded, checked_at: '2026-13-06T01:02:03.004Z' },
    { ...recorded, latest_sha: 'z'.repeat(40) },
    { ...recorded, status: 'paused' },
    { ...recorded, format: 2 },
    { data_id: recorded.data_id, schema_version: '1.0', state: 'absent' },
  ];
  for (const raw of hostile) expect(() => parseNativeUpdateStateView(raw)).toThrow();
  const shifted = { ...catalog(), fields: catalog().fields.slice(0, 7) };
  expect(() => parseNativeUpdateStateCatalog(shifted)).toThrow();
  const loose = { ...catalog(), fields: catalog().fields.map((field) => field.path === 'status'
    ? { ...field, editability: { ...field.editability, available: true } } : field) };
  expect(() => parseNativeUpdateStateCatalog(loose)).toThrow();
  const invented = { ...catalog(), fields: catalog().fields.map((field) => field.path === 'checked_at'
    ? { ...field, classification: 'operator_setting' } : field) };
  expect(() => parseNativeUpdateStateCatalog(invented)).toThrow();
});
