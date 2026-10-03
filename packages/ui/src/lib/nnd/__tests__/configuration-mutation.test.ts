// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { nativeChange, nativeRouteBindingChange, nativeRepairDocument, newNativeOperationId, previewNativeConfiguration, requestNativeConfigurationCatalog,
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
it('admits only complete catalog-advertised reviewer/vision binding pairs and sends one native operation', async () => {
  const pair = (role: 'reviewer' | 'vision', name: 'provider_id' | 'model') => ({
    path: `routes.${role}.${name}`, type: 'unknown', classification: 'operator_setting',
    editability: { available: true, generic_editable: true, scope: 'user', required_permission: 'nnd.configuration.manage',
      operation: 'bind_route', paired_fields: [`routes.${role}.provider_id`, `routes.${role}.model`] },
  });
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...catalog,
    fields: [...catalog.fields, pair('reviewer', 'provider_id'), pair('reviewer', 'model')] })));
  const parsed = await requestNativeConfigurationCatalog(signal);
  expect(parsed.routeBindings).toEqual(['reviewer']);
  expect(parsed.fields.map(item => item.path)).toEqual(['streaming']);
  const request = nativeRouteBindingChange(view, parsed, 'reviewer', 'local', 'review-model');
  expect(request.operations).toEqual([{ op: 'bind_route', role: 'reviewer', provider_id: 'local', model: 'review-model' }]);
  expect(request.expected_revision).toBe(digest);
  expect(() => nativeRouteBindingChange(view, parsed, 'vision', 'local', 'model')).toThrow('nnd_configuration_request_invalid');
  expect(() => nativeRouteBindingChange(view, parsed, 'reviewer', '__proto__', 'model')).toThrow('nnd_configuration_request_invalid');
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...catalog,
    fields: [...catalog.fields, pair('reviewer', 'provider_id')] })));
  expect((await requestNativeConfigurationCatalog(signal)).routeBindings).toEqual([]);
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
it('admits coupled memory controls only when both fields carry the native capability marker', async () => {
  const memoryCatalog = { ...catalog, fields: [
    ...catalog.fields,
    ...(['memory.enabled', 'memory.required'] as const).map(path => ({ ...field, path,
      classification: 'operator_setting', sensitivity: 'public', editability: { ...field.editability,
        generic_editable: true, coupled_fields: ['memory.enabled', 'memory.required'] } })),
  ] };
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify(memoryCatalog)));
  const selected = await requestNativeConfigurationCatalog(signal);
  expect(selected.fields.map(item => item.path)).toEqual(['streaming', 'memory.enabled', 'memory.required']);
  expect(nativeChange(view, selected.fields[1]!, 'set', 'false').operations).toEqual([
    { op: 'set', field: 'memory.enabled', value: false },
  ]);
  expect(nativeChange(view, selected.fields[2]!, 'reset', '').operations).toEqual([
    { op: 'reset', field: 'memory.required' },
  ]);
  expect(() => nativeChange(view, { ...field, path: 'memory.enabled' }, 'set', 'false'))
    .toThrow('nnd_configuration_request_invalid');
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...memoryCatalog,
    fields: memoryCatalog.fields.map(item => item.path === 'memory.required'
      ? { ...item, editability: { ...item.editability, coupled_fields: undefined } } : item) })));
  expect((await requestNativeConfigurationCatalog(signal)).fields.map(item => item.path)).toEqual(['streaming']);
});
it('requires native preview to show both coupled memory effects before saving', async () => {
  const coupled = { ...field, path: 'memory.enabled', editability: { ...field.editability,
    coupled_fields: ['memory.enabled', 'memory.required'] } };
  const request = nativeChange(view, coupled, 'set', 'false');
  const previewView: NativeConfigurationView = { ...view, fields: (['memory.enabled', 'memory.required'] as const).map(path => ({
    path, catalog_path: path, explicit: { present: true, value: false },
    effective: { present: true, value: false, source: 'user' as const }, application: 'not_applied' as const,
  })) };
  const response = { valid: true, expected_revision: digest, resolution_revision: 'b'.repeat(64),
    application: 'not_applied', view: previewView };
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify(response)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, view: { ...previewView,
      fields: previewView.fields.map(item => item.path === 'memory.required'
        ? { ...item, effective: { present: true, value: true, source: 'user' } } : item) } })));
  expect((await previewNativeConfiguration(request, signal)).view.fields).toHaveLength(2);
  await expect(previewNativeConfiguration(request, signal)).rejects.toThrow('nnd_configuration_view_invalid');
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
