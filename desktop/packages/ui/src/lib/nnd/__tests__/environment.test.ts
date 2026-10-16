// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { parseNativeEnvironmentView, parseNativeEnvironmentCatalog, environmentEntryIsSecret } from '../environment.ts';

const NAMES = ['NNA_HOME', 'NNA_PROVIDER_ENDPOINT', 'NNA_MODEL', 'NNA_REDUCED_MOTION', 'NO_COLOR',
  'NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'];
const SECRETS = new Set(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD']);
const identity = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user' };

const entry = (name: string, present = true, value = 'value-text') => ({
  name, secret: SECRETS.has(name), present, value: present && !SECRETS.has(name) ? value : null });
const view = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...identity, schema_version: '1.0', observation_digest: 'ab'.repeat(32),
  observed: NAMES.map((name) => entry(name)), environment_scope: 'service_process', ...override });
const catalog = () => ({ schema_version: '1.0', source: 'environment', scope: 'user',
  fields: NAMES.map((name) => ({ path: name,
    classification: SECRETS.has(name) ? 'operator_credential' : 'operator_setting',
    application: 'restart_service', editability: { available: false, scope: 'user', reason: 'process_environment' } })) });

it.each(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'])('accepts absent %s while refusing credential values in either presence state', name => {
  const observed = NAMES.map(member => entry(member, member !== name));
  expect(parseNativeEnvironmentView(view({ observed })).observed.find(row => row.name === name)).toEqual({ name, secret: true, present: false, value: null });
  for (const present of [false, true]) expect(() => parseNativeEnvironmentView(view({ observed: observed.map(row => row.name === name
    ? { ...row, present, value: 'credential-must-not-cross' } : row) }))).toThrow('nnd_environment_request_invalid');
});

it('environment parser rebuilds the observation and catalog without private fields', () => {
  const parsed = parseNativeEnvironmentView({ ...view(), private_future_field: 'FUTURE' });
  expect(Object.keys(parsed)).toEqual(['schema_version', 'installation_id', 'data_id', 'scope',
    'observation_digest', 'observed', 'environment_scope']);
  expect(parsed.observed.map((item) => item.name)).toEqual(NAMES);
  expect(JSON.stringify(parsed).includes('FUTURE')).toBe(false);
  expect(Object.keys(parseNativeEnvironmentCatalog({ ...catalog(), private_future: 'FUTURE' })))
    .toEqual(['schema_version', 'source', 'scope', 'fields']);
  expect(JSON.stringify(parseNativeEnvironmentCatalog({ ...catalog(), private_future: 'FUTURE' }))
    .includes('FUTURE')).toBe(false);
  expect(parseNativeEnvironmentCatalog(catalog()).fields.map((field) => field.path)).toEqual(NAMES);
  expect(environmentEntryIsSecret('NNA_TELEGRAM_BOT_TOKEN')).toBe(true);
  expect(environmentEntryIsSecret('NNA_HOME')).toBe(false);
});

it('environment parser mirrors redaction and absence exactly like the native surface', () => {
  const absent = view({ observed: (view().observed as Array<Record<string, unknown>>).map((item) => item.name
    === 'NO_COLOR' ? { name: 'NO_COLOR', secret: false, present: false, value: null } : item) });
  expect(parseNativeEnvironmentView(absent).observed[4]).toEqual({
    name: 'NO_COLOR', secret: false, present: false, value: null });
  expect(parseNativeEnvironmentView(view()).observed[5]!.value).toEqual(null);
  const empty = view({ observed: (view().observed as Array<Record<string, unknown>>).map((item) => item.name
    === 'NNA_MODEL' ? { name: 'NNA_MODEL', secret: false, present: true, value: '' } : item) });
  expect(parseNativeEnvironmentView(empty).observed[2]!.value).toBe('');
  for (const raw of [
    view({ observed: (view().observed as Array<Record<string, unknown>>).slice(0, 6) }),
    view({ observed: [...(view().observed as Array<Record<string, unknown>>).slice(1),
      (view().observed as Array<Record<string, unknown>>)[0]] }),
    view({ observed: (view().observed as Array<Record<string, unknown>>).map((item) => item.name
      === 'NNA_TELEGRAM_BOT_TOKEN' ? { ...item, value: 'leak' } : item) }),
    view({ observed: (view().observed as Array<Record<string, unknown>>).map((item) => item.name
      === 'NNA_TELEGRAM_BOT_TOKEN' ? { ...item, secret: false } : item) }),
    view({ observed: (view().observed as Array<Record<string, unknown>>).map((item) => item.name
      === 'NNA_HOME' ? { ...item, present: false } : item) }),
    view({ environment_scope: 'login_scope' }),
    view({ observation_digest: 'not-a-digest' }),
    view({ scope: 'system' }),
  ]) expect(() => parseNativeEnvironmentView(raw)).toThrow();
});

it('environment catalog parser refuses shifted classifications or looser editability', () => {
  const base = catalog();
  for (const raw of [
    { ...base, fields: base.fields.map((field) => field.path === 'NNA_HOME'
      ? { ...field, classification: 'operator_credential' } : field) },
    { ...base, fields: base.fields.map((field) => field.path === 'NNA_MODEL'
      ? { ...field, editability: { available: true, scope: 'user', reason: 'process_environment' } } : field) },
    { ...base, source: 'gateway' },
    { ...base, fields: base.fields.slice(0, 6) },
  ]) expect(() => parseNativeEnvironmentCatalog(raw as unknown)).toThrow();
});
