// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { nativeChange, nativeRepairDocument, newNativeOperationId, previewNativeConfiguration, requestNativeConfigurationCatalog,
  saveNativeConfiguration, lookupNativeConfigurationOperation } from '../configuration-mutation.ts';
import type { NativeConfigurationView } from '../configuration.ts';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('mints a bounded UUID operation identity with Web Crypto', () => {
  expect(newNativeOperationId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
});
const signal = new AbortController().signal;
const digest = 'a'.repeat(64);
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test', scope: 'user',
  source_state: 'present', source_revision: digest, resolution_revision: 'b'.repeat(64), source_revisions: [],
  application: 'not_applied', fields: [{ path: 'streaming', catalog_path: 'streaming', explicit: { present: false },
    effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' }] };
const field = { path: 'streaming', type: 'boolean' as const,
  editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } };
const catalog = { schema_version: '1.0', authority: 'descriptive_only', fields: [
  { ...field, classification: 'operator_setting', sensitivity: 'public', editability: { ...field.editability, generic_editable: true } },
  { path: 'permission_mode', type: 'enum', classification: 'authority_grant', editability: { available: false } },
] };
const receipt = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user', operation_id: 'operation_1',
  persistence: 'saved', persisted_revision: 'c'.repeat(64), before_revision: digest, application: 'not_applied', replayed: false };

it('takes only native-advertised finite user fields and never grants authority fields', async () => {
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify(catalog)));
  const result = await requestNativeConfigurationCatalog(signal);
  expect(result.fields.map(item => item.path)).toEqual(['streaming']);
  expect(runtimeFetch).toHaveBeenCalledWith('/api/v1/nnd/configuration/catalog', expect.objectContaining({ method: 'GET' }));
});
it('uses the exact read revision and resolution for preview and the same request for CAS save', async () => {
  const request = nativeChange(view, field, 'set', 'false');
  const preview = { valid: true, expected_revision: digest, resolution_revision: 'b'.repeat(64), application: 'not_applied', view };
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify(preview)))
    .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  expect((await previewNativeConfiguration(request, signal)).view.installation_id).toBe('nna_test');
  expect((await saveNativeConfiguration(request, 'operation_1', signal)).persistence).toBe('saved');
  const [previewCall, saveCall] = vi.mocked(runtimeFetch).mock.calls;
  expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual(request);
  expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ ...request, operation_id: 'operation_1' });
  expect(() => nativeChange(view, field, 'set', '"false"')).toThrow();
  expect(nativeChange(view, field, 'reset', '').operations).toEqual([{ op: 'reset', field: 'streaming' }]);
});
it('constructs bounded typed attachment intents without elevating authority', () => {
  const enabled = { ...field, path: 'attachments.enabled' };
  const maximum = { ...field, path: 'attachments.max_bytes', type: 'integer' as const };
  expect(nativeChange(view, enabled, 'set', 'false').operations).toEqual([
    { op: 'set', field: 'attachments.enabled', value: false },
  ]);
  expect(nativeChange(view, maximum, 'set', '2048').operations).toEqual([
    { op: 'set', field: 'attachments.max_bytes', value: 2048 },
  ]);
  expect(nativeChange(view, maximum, 'reset', '').operations).toEqual([
    { op: 'reset', field: 'attachments.max_bytes' },
  ]);
  expect(() => nativeChange(view, maximum, 'set', '2048.5')).toThrow('nnd_configuration_request_invalid');
  expect(() => nativeChange(view, enabled, 'set', '"false"')).toThrow('nnd_configuration_request_invalid');
});
it('constructs integer memory limit and reset intents for the native preview contract', () => {
  const limit = { ...field, path: 'memory.timeout_ms', type: 'integer' as const };
  expect(nativeChange(view, limit, 'set', '1000').operations).toEqual([
    { op: 'set', field: 'memory.timeout_ms', value: 1000 },
  ]);
  expect(nativeChange(view, limit, 'reset', '1000').operations).toEqual([
    { op: 'reset', field: 'memory.timeout_ms' },
  ]);
  expect(() => nativeChange(view, limit, 'set', '1000.5')).toThrow('nnd_configuration_request_invalid');
});
it('preserves the operation id for uncertain outcomes and rejects a foreign receipt', async () => {
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'operation_not_found' }), { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, data_id: 'foreign' })));
  expect(await lookupNativeConfigurationOperation(view, 'operation_1', signal)).toBeNull();
  await expect(lookupNativeConfigurationOperation(view, 'operation_1', signal)).rejects.toThrow('nnd_configuration_view_invalid');
});
it('rejects a save receipt for a different CAS base or an impossible saved revision', async () => {
  const request = nativeChange(view, field, 'set', 'false');
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, before_revision: 'd'.repeat(64) })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, persisted_revision: null })));
  await expect(saveNativeConfiguration(request, 'operation_1', signal)).rejects.toThrow('nnd_configuration_view_invalid');
  await expect(saveNativeConfiguration(request, 'operation_1', signal)).rejects.toThrow('nnd_configuration_view_invalid');
});
it('repair input refuses credentials, authority and unknown source keys before HTTP', () => {
  expect(nativeRepairDocument({ workspace_root: 'C:/work', provider: { id: 'local', endpoint: 'http://127.0.0.1:9',
    model: 'base', trust_zone: 'loopback' } })).toBeTruthy();
  expect(() => nativeRepairDocument({ workspace_root: 'C:/work', provider: { id: 'local', endpoint: 'http://127.0.0.1:9',
    model: 'base', trust_zone: 'loopback', credential: 'PRIVATE' } })).toThrow();
  expect(() => nativeRepairDocument({ workspace_root: 'C:/work', provider: { id: 'local', endpoint: 'http://127.0.0.1:9',
    model: 'base', trust_zone: 'loopback' }, allowed_capabilities: ['danger'] })).toThrow();
});
