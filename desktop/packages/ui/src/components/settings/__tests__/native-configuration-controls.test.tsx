// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { nativeChange, nativeRepairDocument, previewNativeConfiguration, repairNativeConfiguration,
  requestNativeConfigurationCatalog, saveNativeConfiguration, newNativeOperationId,
  lookupNativeConfigurationOperation } from '../../../lib/nnd/configuration-mutation.ts';
import { NativeConfigurationControls } from '../pages/native-configuration-controls.tsx';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../../../sync/authority-sync.ts';

const runtimeState = vi.hoisted(() => ({ key: 'local', origin: 'http://127.0.0.1:3000' }));
vi.mock('../../../lib/runtime-switch.ts', async importOriginal => ({ ...(await importOriginal<object>()),
  getRuntimeKey: () => runtimeState.key }));
vi.mock('../../../lib/runtime-url.ts', async importOriginal => ({ ...(await importOriginal<object>()),
  getApiBaseUrl: () => runtimeState.origin }));
vi.mock('../../../lib/nnd/configuration-mutation.ts', () => ({ requestNativeConfigurationCatalog: vi.fn(),
  NativeConfigurationFailure: class NativeConfigurationFailure extends Error { constructor(readonly code: string) { super(code); } },
  nativeChange: vi.fn(), nativeRepairDocument: vi.fn(), newNativeOperationId: vi.fn(() => 'operation_1'), previewNativeConfiguration: vi.fn(),
  saveNativeConfiguration: vi.fn(), repairNativeConfiguration: vi.fn(), lookupNativeConfigurationOperation: vi.fn() }));
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test', scope: 'user',
  source_state: 'present', source_revision: 'a'.repeat(64), resolution_revision: 'b'.repeat(64), source_revisions: [],
  application: 'not_applied', fields: [{ path: 'streaming', catalog_path: 'streaming', explicit: { present: false },
    effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' }] };
const field = { path: 'streaming', type: 'boolean' as const,
  editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } };
const request = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user' as const,
  expected_revision: 'a'.repeat(64), expected_resolution_revision: 'b'.repeat(64),
  operations: [{ op: 'set' as const, field: 'streaming', value: false }] };
let root: Root; let container: HTMLDivElement;
function mount(current: NativeConfigurationView = view) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(<I18nProvider><NativeConfigurationControls view={current} onReload={vi.fn()} /></I18nProvider>));
}
function button(label: string) { const found = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!found) throw new Error('button missing: ' + label); return found; }
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); runtimeState.key = 'local'; runtimeState.origin = 'http://127.0.0.1:3000';
  const token = beginAuthorityRecovery('local'); finishAuthorityRecovery('local', token, true);
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [field] }); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); sessionStorage.clear(); });

it('requires native preview before save and retains the same CAS payload', async () => {
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view });
  vi.mocked(saveNativeConfiguration).mockImplementation(async (_input, operationId) => ({ installation_id: 'nna_test', data_id: 'data_test',
    scope: 'user', operation_id: operationId, persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false }));
  mount(); await act(async () => {});
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => { const select = container.querySelector('select')!; select.value = 'streaming';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { button('Preview change').click(); });
  expect(previewNativeConfiguration).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  await act(async () => { button('Save to NNA').click(); });
  expect(saveNativeConfiguration).toHaveBeenCalledWith(request, expect.any(String), expect.any(AbortSignal));
  expect(container.textContent).toContain('saved'); expect(container.textContent).toContain('not applied');
});

it('edits only advertised native attachment scalars with typed preview and CAS save', async () => {
  const attachmentView: NativeConfigurationView = { ...view, fields: [
    { path: 'attachments.enabled', catalog_path: 'attachments.enabled', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'attachments.max_bytes', catalog_path: 'attachments.max_bytes', explicit: { present: false },
      effective: { present: true, value: 10485760, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'attachments.retain', catalog_path: 'attachments.retain', explicit: { present: false },
      effective: { present: true, value: false, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const maxField = { path: 'attachments.max_bytes', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    maxField, { path: 'attachments.enabled', type: 'boolean', editability: field.editability },
    { path: 'attachments.retain', type: 'boolean', editability: field.editability },
    { path: 'attachments.unknown', type: 'boolean', editability: field.editability },
  ] });
  const attachmentRequest = { ...request, operations: [{ op: 'set' as const, field: maxField.path, value: 2048 }] };
  vi.mocked(nativeChange).mockReturnValue(attachmentRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: attachmentView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(attachmentView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.attachments"]')).not.toBeNull();
  expect(container.textContent).not.toContain('attachments.unknown');
  await act(async () => button('Maximum attachment bytes').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.value).toBe('10485760');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2048');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(attachmentView, maxField, 'set', '2048');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(attachmentRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('offers bounded provider scheduling controls only for fields advertised by NNA', async () => {
  const schedulingView: NativeConfigurationView = { ...view, fields: [
    { path: 'provider_concurrency', catalog_path: 'provider_concurrency', explicit: { present: false },
      effective: { present: true, value: 1, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'provider_queue_limit', catalog_path: 'provider_queue_limit', explicit: { present: false },
      effective: { present: true, value: 256, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const concurrency = { path: 'provider_concurrency', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [concurrency,
    { path: 'provider_queue_limit', type: 'integer', editability: field.editability },
    { path: 'provider_unknown', type: 'integer', editability: field.editability }] });
  const schedulingRequest = { ...request, operations: [{ op: 'set' as const, field: concurrency.path, value: 4 }] };
  vi.mocked(nativeChange).mockReturnValue(schedulingRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: schedulingView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(schedulingView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.provider-scheduling"]')).not.toBeNull();
  expect(container.textContent).not.toContain('provider_unknown');
  await act(async () => button('Concurrent provider requests').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('1'); expect(input.max).toBe('16'); expect(input.value).toBe('1');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(schedulingView, concurrency, 'set', '4');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(schedulingRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('edits advertised recovery budgets through native preview, CAS save, and receipt evidence', async () => {
  const recoveryView: NativeConfigurationView = { ...view, fields: [
    { path: 'recovery.max_model_steps', catalog_path: 'recovery.max_model_steps', explicit: { present: false },
      effective: { present: true, value: 1024, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'recovery.local_retry_limit', catalog_path: 'recovery.local_retry_limit', explicit: { present: false },
      effective: { present: true, value: 3, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const retry = { path: 'recovery.local_retry_limit', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [retry,
    { path: 'recovery.unknown', type: 'integer', editability: field.editability }] });
  const recoveryRequest = { ...request, operations: [{ op: 'set' as const, field: retry.path, value: 4 }] };
  vi.mocked(nativeChange).mockReturnValue(recoveryRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: recoveryView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(recoveryView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.recovery-budgets"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Maximum model steps');
  expect(container.textContent).not.toContain('recovery.unknown');
  await act(async () => button('Local retry limit').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('2'); expect(input.max).toBe('5'); expect(input.value).toBe('3');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '6');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect((button('Preview change') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '03');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect((button('Preview change') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(recoveryView, retry, 'set', '4');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(recoveryRequest, expect.any(AbortSignal));
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(recoveryRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved'); expect(container.textContent).toContain('not applied');
});

it('previews and saves only advertised session deadlines with a bounded native CAS request', async () => {
  const deadlineView: NativeConfigurationView = { ...view, fields: [
    { path: 'approval_timeout_ms', catalog_path: 'approval_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 120000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'shutdown_timeout_ms', catalog_path: 'shutdown_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 15000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const approval = { path: 'approval_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [approval,
    { path: 'persistence_flush_timeout_ms', type: 'integer', editability: field.editability },
    { path: 'session_deadline_unknown', type: 'integer', editability: field.editability }] });
  const deadlineRequest = { ...request, operations: [{ op: 'set' as const, field: approval.path, value: 180000 }] };
  vi.mocked(nativeChange).mockReturnValue(deadlineRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: deadlineView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(deadlineView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.session-deadlines"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Persistence flush timeout (ms)');
  expect(container.textContent).not.toContain('Shutdown timeout (ms)');
  expect(container.textContent).not.toContain('session_deadline_unknown');
  await act(async () => button('Approval wait (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('1000'); expect(input.max).toBe('3600000'); expect(input.value).toBe('120000');
  for (const invalid of ['0', '01000', '3600001']) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, invalid);
      input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((button('Preview change') as HTMLButtonElement).disabled).toBe(true);
  }
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '180000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(deadlineView, approval, 'set', '180000');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(deadlineRequest, expect.any(AbortSignal));
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(deadlineRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved'); expect(container.textContent).toContain('not applied');
});

it('edits a catalog-advertised context threshold through ordered native preview and CAS save', async () => {
  const paths = ['context_compression_threshold', 'context_compression_level_2_threshold',
    'context_compression_level_3_threshold', 'context_compaction_threshold'] as const;
  const values = [0.4, 0.55, 0.7, 0.75];
  const contextView: NativeConfigurationView = { ...view, fields: paths.map((path, index) => ({ path, catalog_path: path,
    explicit: { present: false }, effective: { present: true, value: values[index]!, source: 'compiled_default' },
    application: 'not_applied' })) };
  const compression = { path: paths[0], type: 'number' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [compression,
    { path: 'context_limit_bytes', type: 'integer', editability: field.editability },
    { path: paths[1], type: 'number', editability: field.editability }] });
  const contextRequest = { ...request, operations: [{ op: 'set' as const, field: compression.path, value: 0.42 }] };
  const projectedView: NativeConfigurationView = { ...contextView, fields: contextView.fields.map((row, index) => ({ ...row,
    effective: { present: true, value: [0.42, 0.56, 0.7, 0.75][index]!, source: 'user' } })) };
  vi.mocked(nativeChange).mockReturnValue(contextRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: projectedView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(contextView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.context-budgets"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Context byte ceiling');
  expect(container.textContent).not.toContain('Third compression threshold');
  await act(async () => button('First compression threshold').click());
  const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  expect(input.type).toBe('text'); expect(input.value).toBe('0.4');
  for (const draft of ['0', '0.', '0.4', '0.42']) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, draft);
      input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(input.value).toBe(draft);
    if (draft === '0.') expect((button('Preview change') as HTMLButtonElement).disabled).toBe(true);
  }
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(contextView, compression, 'set', '0.42');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(contextRequest, expect.any(AbortSignal));
  expect(container.textContent).toContain('0.4 → 0.42');
  expect(container.textContent).toContain('0.55 → 0.56');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(contextRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved'); expect(container.textContent).toContain('not applied');
});

it('does not offer a save when NNA rejects a coupled context threshold during preview', async () => {
  const contextView: NativeConfigurationView = { ...view, fields: [
    { path: 'context_compression_threshold', catalog_path: 'context_compression_threshold',
      explicit: { present: false }, effective: { present: true, value: 0.4, source: 'compiled_default' },
      application: 'not_applied' },
  ] };
  const compression = { path: 'context_compression_threshold', type: 'number' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [compression] });
  vi.mocked(nativeChange).mockReturnValue({ ...request, operations: [{ op: 'set', field: compression.path, value: 0.8 }] });
  vi.mocked(previewNativeConfiguration).mockRejectedValue(Object.assign(new Error('order rejected'),
    { code: 'context_thresholds_invalid' }));
  mount(contextView); await act(async () => {});
  await act(async () => button('First compression threshold').click());
  const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0.8');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(container.textContent).toContain('context_thresholds_invalid');
  expect(container.textContent).not.toContain('Save to NNA');
  expect(saveNativeConfiguration).not.toHaveBeenCalled();
});

it('bounds advertised reviewer-ledger retention and saves through native preview and CAS', async () => {
  const retentionPath = 'reviewer_ledger.retention_entries';
  const retentionView: NativeConfigurationView = { ...view, fields: [
    { path: retentionPath, catalog_path: retentionPath, explicit: { present: false },
      effective: { present: true, value: 10000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'telemetry.retention', catalog_path: 'telemetry.retention', explicit: { present: false },
      effective: { present: true, value: null, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const retention = { path: retentionPath, type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [retention,
    { path: 'telemetry.retention', type: 'string', editability: field.editability }] });
  const retentionRequest = { ...request, operations: [{ op: 'set' as const, field: retentionPath, value: 5000 }] };
  vi.mocked(nativeChange).mockReturnValue(retentionRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: retentionView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(retentionView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.reviewer-retention"]')).not.toBeNull();
  await act(async () => button('Retained review operations').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('1'); expect(input.max).toBe('100000'); expect(input.value).toBe('10000');
  for (const invalid of ['0', '05000', '100001']) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, invalid);
      input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((button('Preview change') as HTMLButtonElement).disabled).toBe(true);
  }
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '5000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(retentionView, retention, 'set', '5000');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(retentionRequest, expect.any(AbortSignal));
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(retentionRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved'); expect(container.textContent).toContain('not applied');
});

it('does not offer reviewer-retention editing when NNA omits it from the catalog', async () => {
  const retentionPath = 'reviewer_ledger.retention_entries';
  const retentionView: NativeConfigurationView = { ...view, fields: [
    { path: retentionPath, catalog_path: retentionPath, explicit: { present: false },
      effective: { present: true, value: 10000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [field] });
  mount(retentionView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.reviewer-retention"]')).toBeNull();
});

it('previews and saves a catalog-advertised dream idle limit with native CAS', async () => {
  const dreamView: NativeConfigurationView = { ...view, fields: [
    { path: 'dream.idle_ms', catalog_path: 'dream.idle_ms', explicit: { present: false },
      effective: { present: true, value: 45000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const idle = { path: 'dream.idle_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [idle,
    { path: 'dream.unknown', type: 'integer', editability: field.editability }] });
  const dreamRequest = { ...request, operations: [{ op: 'set' as const, field: idle.path, value: 60000 }] };
  vi.mocked(nativeChange).mockReturnValue(dreamRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: dreamView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(dreamView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.dream"]')).not.toBeNull();
  expect(container.textContent).not.toContain('dream.unknown');
  await act(async () => button('Idle before maintenance (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('5000'); expect(input.max).toBe('3600000'); expect(input.value).toBe('45000');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '60000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(dreamView, idle, 'set', '60000');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(dreamRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('renders all five memory census rows in the memory block with the native bounds', async () => {
  const memoryView: NativeConfigurationView = { ...view, fields: [
    { path: 'memory.enabled', catalog_path: 'memory.enabled', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.required', catalog_path: 'memory.required', explicit: { present: false },
      effective: { present: true, value: false, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.timeout_ms', catalog_path: 'memory.timeout_ms', explicit: { present: false },
      effective: { present: true, value: 750, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.max_items', catalog_path: 'memory.max_items', explicit: { present: false },
      effective: { present: true, value: 8, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.max_bytes', catalog_path: 'memory.max_bytes', explicit: { present: false },
      effective: { present: true, value: 16384, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'memory.enabled', type: 'boolean', editability: field.editability },
    { path: 'memory.required', type: 'boolean', editability: field.editability },
    { path: 'memory.timeout_ms', type: 'integer', editability: field.editability },
    { path: 'memory.max_items', type: 'integer', editability: field.editability },
    { path: 'memory.max_bytes', type: 'integer', editability: field.editability },
  ] });
  mount(memoryView); await act(async () => {});
  const block = () => container.querySelector('[data-settings-item="native-configuration.memory-limits"]')?.textContent ?? '';
  expect(block()).toContain('Enable memory');
  expect(block()).toContain('Require memory');
  const limits: Array<[string, number, number, number]> = [
    ['Memory timeout (ms)', 750, 50, 30000],
    ['Maximum memory items', 8, 1, 64],
    ['Maximum memory bytes', 16384, 1024, 262144],
  ];
  for (const [label, value, min, max] of limits) {
    expect(block()).toContain(label);
    await act(async () => { button(label).click(); });
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value, label).toBe(String(value));
    expect(input.min, label).toBe(String(min)); expect(input.max, label).toBe(String(max));
  }
});

it('renders all six dream census rows in the dream block with the native bounds', async () => {
  const dreamView: NativeConfigurationView = { ...view, fields: [
    { path: 'dream.enabled', catalog_path: 'dream.enabled', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'dream.idle_ms', catalog_path: 'dream.idle_ms', explicit: { present: false },
      effective: { present: true, value: 45000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'dream.inter_stage_ms', catalog_path: 'dream.inter_stage_ms', explicit: { present: false },
      effective: { present: true, value: 5000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'dream.inference_idle_ms', catalog_path: 'dream.inference_idle_ms', explicit: { present: false },
      effective: { present: true, value: 120000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'dream.hygiene_idle_ms', catalog_path: 'dream.hygiene_idle_ms', explicit: { present: false },
      effective: { present: true, value: 300000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'dream.retention_days', catalog_path: 'dream.retention_days', explicit: { present: false },
      effective: { present: true, value: 30, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'dream.enabled', type: 'boolean', editability: field.editability },
    { path: 'dream.idle_ms', type: 'integer', editability: field.editability },
    { path: 'dream.inter_stage_ms', type: 'integer', editability: field.editability },
    { path: 'dream.inference_idle_ms', type: 'integer', editability: field.editability },
    { path: 'dream.hygiene_idle_ms', type: 'integer', editability: field.editability },
    { path: 'dream.retention_days', type: 'integer', editability: field.editability },
  ] });
  mount(dreamView); await act(async () => {});
  const block = () => container.querySelector('[data-settings-item="native-configuration.dream"]')?.textContent ?? '';
  expect(block()).toContain('Enable dream maintenance');
  // The editor bounds mirror src/configuration-rules.js exactly.
  const limits: Array<[string, number, number, number]> = [
    ['Idle before maintenance (ms)', 45000, 5000, 3600000],
    ['Pause between stages (ms)', 5000, 1000, 300000],
    ['Inference idle delay (ms)', 120000, 10000, 3600000],
    ['Hygiene idle delay (ms)', 300000, 30000, 7200000],
    ['Retain dream records (days)', 30, 1, 365],
  ];
  for (const [label, value, min, max] of limits) {
    expect(block()).toContain(label);
    await act(async () => { button(label).click(); });
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value, label).toBe(String(value));
    expect(input.min, label).toBe(String(min)); expect(input.max, label).toBe(String(max));
  }
});

it('shows host-effective dream enablement from the native preview rather than claiming activation', async () => {
  const dreamView: NativeConfigurationView = { ...view, fields: [
    { path: 'dream.enabled', catalog_path: 'dream.enabled', explicit: { present: false },
      effective: { present: true, value: false, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const enabled = { path: 'dream.enabled', type: 'boolean' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [enabled] });
  vi.mocked(nativeChange).mockReturnValue({ ...request, operations: [{ op: 'set', field: enabled.path, value: true }] });
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: dreamView });
  mount(dreamView); await act(async () => {});
  await act(async () => button('Enable dream maintenance').click());
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(dreamView, enabled, 'set', 'true');
  expect(container.textContent).toContain('"value":false');
  expect(container.textContent).toContain('new constructed context');
  expect(saveNativeConfiguration).not.toHaveBeenCalled();
});

it('offers only advertised native memory limits and saves a typed bounded value through the same CAS request', async () => {
  const memoryView: NativeConfigurationView = { ...view, fields: [
    { path: 'memory.timeout_ms', catalog_path: 'memory.timeout_ms', explicit: { present: false },
      effective: { present: true, value: 750, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.max_items', catalog_path: 'memory.max_items', explicit: { present: false },
      effective: { present: true, value: 8, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'memory.max_bytes', catalog_path: 'memory.max_bytes', explicit: { present: false },
      effective: { present: true, value: 16384, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const maxField = { path: 'memory.max_bytes', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    maxField, { path: 'memory.timeout_ms', type: 'integer', editability: field.editability },
    { path: 'memory.max_items', type: 'integer', editability: field.editability },
    { path: 'memory.unknown', type: 'integer', editability: field.editability },
  ] });
  const memoryRequest = { ...request, operations: [{ op: 'set' as const, field: maxField.path, value: 32768 }] };
  vi.mocked(nativeChange).mockReturnValue(memoryRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: memoryView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(memoryView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.memory-limits"]')).not.toBeNull();
  expect(container.textContent).not.toContain('memory.unknown');
  await act(async () => button('Maximum memory bytes').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('1024'); expect(input.max).toBe('262144'); expect(input.value).toBe('16384');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '32768');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(memoryView, maxField, 'set', '32768');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(memoryRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('previews and saves bounded connection timeout through native CAS', async () => {
  const timeoutView: NativeConfigurationView = { ...view, fields: [
    { path: 'provider_connect_timeout_ms', catalog_path: 'provider_connect_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 10000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'semantic_review_timeout_ms', catalog_path: 'semantic_review_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 1800000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const connection = { path: 'provider_connect_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [connection,
    { path: 'semantic_review_timeout_ms', type: 'integer', editability: field.editability },
    { path: 'unknown_timeout_ms', type: 'integer', editability: field.editability }] });
  const timeoutRequest = { ...request, operations: [{ op: 'set' as const, field: connection.path, value: 20000 }] };
  vi.mocked(nativeChange).mockReturnValue(timeoutRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: timeoutView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(timeoutView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.runtime-timeouts"]')).not.toBeNull();
  expect(container.textContent).not.toContain('unknown_timeout_ms');
  await act(async () => button('Provider connection timeout (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('100'); expect(input.max).toBe('600000'); expect(input.value).toBe('10000');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '20000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(timeoutView, connection, 'set', '20000');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(timeoutRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('resets semantic-review timeout to its native inherited value', async () => {
  const timeoutView: NativeConfigurationView = { ...view, fields: [
    { path: 'semantic_review_timeout_ms', catalog_path: 'semantic_review_timeout_ms', explicit: { present: true, value: 250000 },
      effective: { present: true, value: 250000, source: 'user' }, application: 'not_applied' },
  ] };
  const semantic = { path: 'semantic_review_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [semantic] });
  const resetRequest = { ...request, operations: [{ op: 'reset' as const, field: semantic.path }] };
  vi.mocked(nativeChange).mockReturnValue(resetRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: timeoutView });
  mount(timeoutView); await act(async () => {});
  await act(async () => button('Semantic review timeout (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('100'); expect(input.max).toBe('86400000');
  await act(async () => { const action = [...container.querySelectorAll('select')][1]!;
    action.value = 'reset'; action.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('input[type="number"]')).toBeNull();
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(timeoutView, semantic, 'reset', '250000');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(resetRequest, expect.any(AbortSignal));
});

it('warns that the legacy semantic-review value does not set a 15-second timeout', async () => {
  const timeoutView: NativeConfigurationView = { ...view, fields: [
    { path: 'semantic_review_timeout_ms', catalog_path: 'semantic_review_timeout_ms', explicit: { present: true, value: 15000 },
      effective: { present: true, value: 1800000, source: 'user' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'semantic_review_timeout_ms', type: 'integer', editability: field.editability },
  ] });
  mount(timeoutView); await act(async () => {});
  await act(async () => button('Semantic review timeout (ms)').click());
  expect(container.textContent).toContain('NNA treats 15000 ms as a legacy inherited value');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('15000');
});

it('previews both provider deadline values before saving zero as a primary override', async () => {
  const deadlineView: NativeConfigurationView = { ...view, fields: [
    { path: 'provider_timeout_ms', catalog_path: 'provider_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 300000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'routes.primary.deadline_ms', catalog_path: 'routes.primary.deadline_ms', explicit: { present: true, value: 300000 },
      effective: { present: true, value: 300000, source: 'user' }, application: 'not_applied' },
  ] };
  const disabledView: NativeConfigurationView = { ...deadlineView, fields: deadlineView.fields.map(row => ({ ...row,
    effective: { present: true as const, value: 0, source: 'user' as const } })) };
  const primary = { path: 'routes.primary.deadline_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [primary,
    { path: 'provider_timeout_ms', type: 'integer', editability: field.editability }] });
  const deadlineRequest = { ...request, operations: [{ op: 'set' as const, field: primary.path, value: 0 }] };
  vi.mocked(nativeChange).mockReturnValue(deadlineRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: disabledView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(deadlineView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.provider-deadline"]')).not.toBeNull();
  await act(async () => button('Primary route deadline (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('100'); expect(input.max).toBe('86400000');
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  expect((container.querySelector('input[type="number"]') as HTMLInputElement).disabled).toBe(true);
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(deadlineView, primary, 'set', '0');
  expect(container.textContent).toContain('Global provider timeout (ms): 300000 → Disable deadline (0)');
  expect(container.textContent).toContain('Primary route deadline (ms): 300000 → Disable deadline (0)');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(deadlineRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('shows a saved global timeout change hidden by a primary override', async () => {
  const deadlineView: NativeConfigurationView = { ...view, fields: [
    { path: 'provider_timeout_ms', catalog_path: 'provider_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 300000, source: 'user' }, application: 'not_applied' },
    { path: 'routes.primary.deadline_ms', catalog_path: 'routes.primary.deadline_ms', explicit: { present: true, value: 300000 },
      effective: { present: true, value: 300000, source: 'user' }, application: 'not_applied' },
  ] };
  const previewView: NativeConfigurationView = { ...deadlineView, fields: deadlineView.fields.map(row => row.path === 'provider_timeout_ms'
    ? { ...row, explicit: { present: true as const, value: 600000 } } : row) };
  const global = { path: 'provider_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [global] });
  vi.mocked(nativeChange).mockReturnValue({ ...request, operations: [{ op: 'set', field: global.path, value: 600000 }] });
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: previewView });
  mount(deadlineView); await act(async () => {});
  await act(async () => button('Global provider timeout (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '600000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(container.textContent).toContain('300000 → 300000; Saved value: Not set → 600000');
});

it('rejects an in-between provider deadline before native preview', async () => {
  const deadlineView: NativeConfigurationView = { ...view, fields: [
    { path: 'provider_timeout_ms', catalog_path: 'provider_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 1800000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'provider_timeout_ms', type: 'integer', editability: field.editability }] });
  mount(deadlineView); await act(async () => {});
  await act(async () => button('Global provider timeout (ms)').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '99');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Preview change').disabled).toBe(true);
  expect(previewNativeConfiguration).not.toHaveBeenCalled();
});

it('declines ambiguous stream sentinels and saves a fixed first-token timeout through native CAS', async () => {
  const streamView: NativeConfigurationView = { ...view, fields: [
    { path: 'first_token_timeout_ms', catalog_path: 'first_token_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 600000, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'idle_timeout_ms', catalog_path: 'idle_timeout_ms', explicit: { present: false },
      effective: { present: true, value: 300000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  const first = { path: 'first_token_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [first,
    { path: 'idle_timeout_ms', type: 'integer', editability: field.editability }] });
  const fixedRequest = { ...request, operations: [{ op: 'set' as const, field: first.path, value: 120000 }] };
  vi.mocked(nativeChange).mockReturnValue(fixedRequest);
  const projected: NativeConfigurationView = { ...streamView, fields: streamView.fields.map(row => row.path === first.path
    ? { ...row, explicit: { present: true as const, value: 120000 },
      effective: { present: true as const, value: 120000, source: 'user' as const } } : row) };
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: projected });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(streamView); await act(async () => {});
  expect(container.querySelector('[data-settings-item="native-configuration.stream-timeouts"]')).not.toBeNull();
  await act(async () => button('First-token timeout (ms)').click());
  expect(button('Preview change').disabled).toBe(true);
  expect(container.textContent).toContain('cannot pin 30000 ms or 600000 ms');
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe('100'); expect(input.max).toBe('86400000');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '120000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(streamView, first, 'set', '120000');
  expect(container.textContent).toContain('First-token timeout (ms): 600000 → 120000');
  expect(container.textContent).toContain('Idle timeout (ms): 300000 → 300000');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(fixedRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('offers zero as disabled while refusing idle legacy and paired-default values', async () => {
  const streamView: NativeConfigurationView = { ...view, fields: [
    { path: 'idle_timeout_ms', catalog_path: 'idle_timeout_ms', explicit: { present: true, value: 45000 },
      effective: { present: true, value: 300000, source: 'user' }, application: 'not_applied' },
  ] };
  const idle = { path: 'idle_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [idle] });
  vi.mocked(nativeChange).mockReturnValue({ ...request, operations: [{ op: 'set', field: idle.path, value: 0 }] });
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: streamView });
  mount(streamView); await act(async () => {});
  await act(async () => button('Idle timeout (ms)').click());
  expect(button('Preview change').disabled).toBe(true);
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '300000');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Preview change').disabled).toBe(true);
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(streamView, idle, 'set', '0');
});

it('resets a legacy stream timeout to inherited native policy', async () => {
  const streamView: NativeConfigurationView = { ...view, fields: [
    { path: 'idle_timeout_ms', catalog_path: 'idle_timeout_ms', explicit: { present: true, value: 45000 },
      effective: { present: true, value: 300000, source: 'user' }, application: 'not_applied' },
  ] };
  const idle = { path: 'idle_timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [idle] });
  const resetRequest = { ...request, operations: [{ op: 'reset' as const, field: idle.path }] };
  vi.mocked(nativeChange).mockReturnValue(resetRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: streamView });
  mount(streamView); await act(async () => {});
  await act(async () => button('Idle timeout (ms)').click());
  await act(async () => { const action = [...container.querySelectorAll('select')][1]!;
    action.value = 'reset'; action.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('input[type="number"]')).toBeNull();
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(streamView, idle, 'reset', '45000');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(resetRequest, expect.any(AbortSignal));
});

it('resets a native memory limit without sending a draft value', async () => {
  const memoryView: NativeConfigurationView = { ...view, fields: [
    { path: 'memory.timeout_ms', catalog_path: 'memory.timeout_ms', explicit: { present: true, value: 1000 },
      effective: { present: true, value: 1000, source: 'user' }, application: 'not_applied' },
  ] };
  const timeoutField = { path: 'memory.timeout_ms', type: 'integer' as const, editability: field.editability };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [timeoutField] });
  const resetRequest = { ...request, operations: [{ op: 'reset' as const, field: timeoutField.path }] };
  vi.mocked(nativeChange).mockReturnValue(resetRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: memoryView });
  mount(memoryView); await act(async () => {});
  await act(async () => button('Memory timeout (ms)').click());
  await act(async () => { const action = [...container.querySelectorAll('select')][1]!;
    action.value = 'reset'; action.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('input[type="number"]')).toBeNull();
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(memoryView, timeoutField, 'reset', '1000');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(resetRequest, expect.any(AbortSignal));
});

it('shows both coupled memory values before saving the same native CAS request', async () => {
  const rows = (['memory.enabled', 'memory.required'] as const).map(path => ({ path, catalog_path: path,
    explicit: { present: true as const, value: true }, effective: { present: true as const, value: true,
      source: 'user' as const }, application: 'not_applied' as const }));
  const memoryView: NativeConfigurationView = { ...view, fields: rows };
  const previewView: NativeConfigurationView = { ...view, fields: rows.map(row => ({ ...row,
    explicit: { present: true as const, value: false }, effective: { present: true as const, value: false,
      source: 'user' as const } })) };
  const paired = ['memory.enabled', 'memory.required'];
  const enabledField = { path: 'memory.enabled', type: 'boolean' as const,
    editability: { ...field.editability, coupled_fields: paired } };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [enabledField,
    { ...enabledField, path: 'memory.required' }] });
  const memoryRequest = { ...request, operations: [{ op: 'set' as const, field: 'memory.enabled', value: false }] };
  vi.mocked(nativeChange).mockReturnValue(memoryRequest);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view: previewView });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: request.expected_revision, application: 'not_applied', replayed: false });
  mount(memoryView); await act(async () => {});
  await act(async () => button('Enable memory').click());
  expect(container.textContent).toContain('NNA memory');
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  expect(container.textContent).toContain('Disabling memory also turns off required memory.');
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(memoryView, enabledField, 'set', 'false');
  expect(container.textContent).toContain('Enable memory: true → false');
  expect(container.textContent).toContain('Require memory: true → false');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(memoryRequest, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('not applied');
});

it('keeps save unavailable when a coupled memory preview is shadowed by a project setting', async () => {
  const memoryView: NativeConfigurationView = { ...view, fields: (['memory.enabled', 'memory.required'] as const).map(path => ({
    path, catalog_path: path, explicit: { present: false as const },
    effective: { present: true as const, value: true, source: 'user' as const }, application: 'not_applied' as const,
  })) };
  const coupled_fields = ['memory.enabled', 'memory.required'];
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: memoryView.fields.map(row => ({
    path: row.path, type: 'boolean' as const, editability: { ...field.editability, coupled_fields },
  })) });
  vi.mocked(nativeChange).mockReturnValue({ ...request,
    operations: [{ op: 'set', field: 'memory.required', value: true }] });
  vi.mocked(previewNativeConfiguration).mockRejectedValue(Object.assign(new Error('shadowed'),
    { code: 'configuration_source_shadowed' }));
  mount(memoryView); await act(async () => {});
  await act(async () => button('Require memory').click());
  await act(async () => button('Preview change').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('configuration_source_shadowed');
  expect(container.textContent).not.toContain('Save to NNA');
  expect(saveNativeConfiguration).not.toHaveBeenCalled();
});

it('preserves the settings draft but disables native writes during a replay gap', async () => {
  mount(); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'streaming';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  const draft = container.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'false');
    draft.dispatchEvent(new Event('input', { bubbles: true })); });
  let token = 0;
  await act(async () => { token = beginAuthorityRecovery('local'); });
  expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  expect(container.querySelector('textarea')?.value).toBe('false');
  button('Preview change').click();
  expect(previewNativeConfiguration).not.toHaveBeenCalled();
  await act(async () => { finishAuthorityRecovery('local', token, false); });
  expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  await act(async () => { token = beginAuthorityRecovery('local'); finishAuthorityRecovery('local', token, true); });
  expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
});

it('repair requires explicit confirmation and a user-supplied replacement document', async () => {
  const missing = { ...view, source_state: 'missing' as const, source_revision: 'absent', resolution_revision: null, fields: [] };
  vi.mocked(nativeRepairDocument).mockReturnValue({ workspace_root: 'C:/work', provider: { id: 'local' } });
  vi.mocked(repairNativeConfiguration).mockImplementation(async (_view, _document, operationId) => ({ installation_id: 'nna_test',
    data_id: 'data_test', scope: 'user', operation_id: operationId, persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: 'absent', application: 'not_applied', replayed: false }));
  mount(missing); await act(async () => {});
  expect(button('Repair selected source').disabled).toBe(true);
  await act(async () => { const check = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    check.click(); });
  await act(async () => { button('Repair selected source').click(); });
  expect(nativeRepairDocument).toHaveBeenCalledWith(expect.objectContaining({ workspace_root: '' }));
  expect(repairNativeConfiguration).toHaveBeenCalledWith(missing, expect.any(Object), expect.any(String), expect.any(AbortSignal));
});

it('retains the submitted operation identity when save is clicked twice before a render', async () => {
  vi.mocked(newNativeOperationId).mockReturnValueOnce('operation_1').mockReturnValueOnce('operation_2');
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view });
  let failSave!: (error: Error) => void;
  vi.mocked(saveNativeConfiguration).mockImplementation(() => new Promise((_, reject) => { failSave = reject; }));
  vi.mocked(lookupNativeConfigurationOperation).mockResolvedValue(null);
  mount(); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'streaming';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { button('Preview change').click(); });
  act(() => { const save = button('Save to NNA'); save.click(); save.click(); });
  expect(newNativeOperationId).toHaveBeenCalledTimes(1);
  expect(saveNativeConfiguration).toHaveBeenCalledTimes(1);
  await act(async () => { failSave(new Error('network')); });
  expect(container.textContent).toContain('operation_1');
  await act(async () => { button('Inspect operation').click(); });
  expect(lookupNativeConfigurationOperation).toHaveBeenCalledWith(view, 'operation_1', expect.any(AbortSignal));
});

it('shows native permission denial and does not offer save when preview is denied', async () => {
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockRejectedValue(Object.assign(new Error('denied'), { code: 'integration_permission_denied' }));
  mount(); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'streaming';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { button('Preview change').click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('integration_permission_denied');
  expect(container.textContent).not.toContain('Save to NNA');
  expect(saveNativeConfiguration).not.toHaveBeenCalled();
});

it('recovers an uncertain save only on the same runtime and native identity', async () => {
  vi.mocked(newNativeOperationId).mockReturnValue('operation_1');
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: request.expected_revision,
    resolution_revision: request.expected_resolution_revision, application: 'not_applied', view });
  vi.mocked(saveNativeConfiguration).mockImplementation(() => new Promise(() => {}));
  vi.mocked(lookupNativeConfigurationOperation).mockResolvedValue(null);
  mount(); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'streaming';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { button('Preview change').click(); });
  act(() => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledTimes(1);
  act(() => root.unmount()); container.remove();

  runtimeState.key = 'host:other';
  mount(); await act(async () => {});
  expect(container.textContent).not.toContain('operation_1');
  act(() => root.unmount()); container.remove();

  runtimeState.key = 'local';
  mount({ ...view, data_id: 'another_data' }); await act(async () => {});
  expect(container.textContent).not.toContain('operation_1');
  act(() => root.unmount()); container.remove();

  vi.mocked(requestNativeConfigurationCatalog).mockImplementationOnce(() => new Promise(() => {}));
  mount();
  expect(container.textContent).toContain('operation_1');
  vi.mocked(lookupNativeConfigurationOperation).mockResolvedValueOnce({ installation_id: 'nna_test', data_id: 'data_test',
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: 'd'.repeat(64), application: 'not_applied', replayed: false });
  await act(async () => { button('Inspect operation').click(); });
  expect(lookupNativeConfigurationOperation).toHaveBeenCalledWith(view, 'operation_1', expect.any(AbortSignal));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('nnd_configuration_view_invalid');
  expect(container.textContent).toContain('operation_1');
  expect(sessionStorage.getItem('nnd.configuration.pending.v1')).toContain('operation_1');
  expect(saveNativeConfiguration).toHaveBeenCalledTimes(1);
});

it('recovers an uncertain repair without copying a replacement document into session storage', async () => {
  const missing = { ...view, source_state: 'missing' as const, source_revision: 'absent', resolution_revision: null, fields: [] };
  vi.mocked(newNativeOperationId).mockReturnValue('operation_1');
  vi.mocked(nativeRepairDocument).mockReturnValue({ workspace_root: 'C:/private', provider: { id: 'local' } });
  vi.mocked(repairNativeConfiguration).mockImplementation(() => new Promise(() => {}));
  mount(missing); await act(async () => {});
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  act(() => button('Repair selected source').click());
  expect(repairNativeConfiguration).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('nnd.configuration.pending.v1')).not.toContain('C:/private');
  act(() => root.unmount()); container.remove();
  mount(missing); await act(async () => {});
  expect(container.textContent).toContain('operation_1');
  expect(button('Repair selected source').disabled).toBe(true);
});

it('renders all three attachment census rows in the attachment block with the native byte bounds', async () => {
  const attachmentView: NativeConfigurationView = { ...view, fields: [
    { path: 'attachments.enabled', catalog_path: 'attachments.enabled', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'attachments.max_bytes', catalog_path: 'attachments.max_bytes', explicit: { present: false },
      effective: { present: true, value: 10485760, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'attachments.retain', catalog_path: 'attachments.retain', explicit: { present: false },
      effective: { present: true, value: false, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'attachments.enabled', type: 'boolean', editability: field.editability },
    { path: 'attachments.max_bytes', type: 'integer', editability: field.editability },
    { path: 'attachments.retain', type: 'boolean', editability: field.editability },
  ] });
  mount(attachmentView); await act(async () => {});
  const block = () => container.querySelector('[data-settings-item="native-configuration.attachments"]')?.textContent ?? '';
  expect(block()).toContain('Enable attachments');
  expect(block()).toContain('Maximum attachment bytes');
  expect(block()).toContain('Retain attachments');
  await act(async () => button('Maximum attachment bytes').click());
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.value).toBe('10485760');
  expect(input.min).toBe('1024');
  expect(input.max).toBe('104857600');
});

it('renders every bounded manifest scalar row in its block with the native bounds', async () => {
  // Integer bounds mirror src/configuration-rules.js exactly; NNA owns them
  // and the input carries them. tool_concurrency also appears in the
  // catalog-gated chooser, but once selected the bounded number input edits
  // it (the raw JSON textarea is suppressed for scheduling rows).
  const bounded: Array<[string, string, number, number, number]> = [
    ['Global provider timeout (ms)', 'provider_timeout_ms', 1800000, 100, 86400000],
    ['Provider connection timeout (ms)', 'provider_connect_timeout_ms', 10000, 100, 600000],
    ['Semantic review timeout (ms)', 'semantic_review_timeout_ms', 1800000, 100, 86400000],
    ['Approval wait (ms)', 'approval_timeout_ms', 120000, 1000, 3600000],
    ['Concurrent provider requests', 'provider_concurrency', 1, 1, 16],
    ['Provider queue limit', 'provider_queue_limit', 256, 1, 4096],
    ['Parallel tool limit', 'tool_concurrency', 1, 1, 16],
    ['Persistence flush timeout (ms)', 'persistence_flush_timeout_ms', 10000, 100, 120000],
    ['Shutdown timeout (ms)', 'shutdown_timeout_ms', 15000, 100, 120000],
    ['Context byte ceiling', 'context_limit_bytes', 2097152, 65536, 16777216],
  ];
  const valueOf = new Map(bounded.map(([, path, value]) => [path, value] as const));
  const scalarView: NativeConfigurationView = {
    ...view,
    fields: [...valueOf].map(([path, value]) => ({
      path, catalog_path: path, explicit: { present: false },
      effective: { present: true, value, source: 'compiled_default' }, application: 'not_applied' as const,
    })),
  };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [...valueOf].map(([path]) => ({
    path, type: 'integer', editability: field.editability,
  })) });
  mount(scalarView); await act(async () => {});
  expect(container.querySelector('select')?.textContent).toContain('tool_concurrency');
  expect(container.querySelector('[data-settings-item="native-configuration.provider-scheduling"]')?.textContent)
    .toContain('Parallel tool limit');
  for (const [label, , value, min, max] of bounded) {
    expect(container.textContent, label).toContain(label);
    await act(async () => button(label).click());
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input, `${label} number input`).not.toBeNull();
    expect(input!.value, label).toBe(String(value));
    expect(input!.min, label).toBe(String(min));
    expect(input!.max, label).toBe(String(max));
  }
});

it('validates the four context threshold drafts against the native decimal bounds', async () => {
  // The decimal thresholds ride a text field with inputMode, so the range is
  // enforced by validation rather than by HTML min/max: a draft outside
  // src/configuration-rules.js keeps Preview disabled.
  const thresholds: Array<[string, string, number, string]> = [
    ['context_compression_threshold', 'First compression threshold (0–1)', 0.4, '0.1'],
    ['context_compression_level_2_threshold', 'Second compression threshold (0–1)', 0.55, '0.1'],
    ['context_compression_level_3_threshold', 'Third compression threshold (0–1)', 0.7, '1.5'],
    ['context_compaction_threshold', 'Full compaction threshold (0–1)', 0.75, '0.2'],
  ];
  const decimalView: NativeConfigurationView = {
    ...view,
    fields: thresholds.map(([path, , value]) => ({
      path, catalog_path: path, explicit: { present: false },
      effective: { present: true, value, source: 'compiled_default' }, application: 'not_applied' as const,
    })),
  };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: thresholds.map(([path]) => ({
    path, type: 'number', editability: field.editability,
  })) });
  mount(decimalView); await act(async () => {});
  for (const [, label, value, tooLow] of thresholds) {
    await act(async () => button(label).click());
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input, `${label} text input`).not.toBeNull();
    expect(input!.value, label).toBe(String(value));
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, tooLow);
      input!.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((button('Preview change') as HTMLButtonElement).disabled, `${label} rejects ${tooLow}`).toBe(true);
  }
});

it('offers the remaining advertised route rows in the catalog-gated field chooser', async () => {
  // The routes page now tunes every role's scalar and list members; this
  // generic chooser on the native configuration page still accepts whatever
  // the catalog advertises — including the primary/subagent rows — through
  // the same preview-and-save ceremony, so this test keeps proving the
  // generic path for them.
  const tuning = ['budget', 'context_limit_bytes', 'deadline_ms', 'enable_thinking', 'max_output_tokens',
    'reasoning_effort', 'temperature'];
  const routePaths = ['primary', 'subagent'].flatMap(role => [...tuning.map(key => `routes.${role}.${key}`),
    `routes.${role}.required_capabilities`, `routes.${role}.fallbacks`])
    .concat(['reviewer', 'vision'].flatMap(role => [`routes.${role}.required_capabilities`, `routes.${role}.fallbacks`]));
  expect(routePaths).toHaveLength(22);
  const routeView: NativeConfigurationView = {
    ...view,
    fields: routePaths.map(path => ({
      path, catalog_path: path, explicit: { present: false },
      effective: { present: true, value: null, source: 'compiled_default' }, application: 'not_applied' as const,
    })),
  };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({
    fields: routePaths.map(path => ({ path,
      type: path.endsWith('temperature') ? 'number' as const : path.endsWith('enable_thinking') ? 'boolean' as const
        : path.endsWith('required_capabilities') || path.endsWith('fallbacks') ? 'array' as const : 'integer' as const,
      editability: field.editability })),
  });
  mount(routeView); await act(async () => {});
  const options = [...container.querySelector('select')!.querySelectorAll('option')].map(option => option.value);
  for (const path of routePaths) expect(options, path).toContain(path);
  await act(async () => { const select = container.querySelector('select')!; select.value = 'routes.primary.budget';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('routes.primary.budget');
  expect(container.textContent).toContain('Preview change');
});

it('offers a typed telemetry block that mirrors the credential-free destination rule', async () => {
  const served = (path: string, type: 'boolean' | 'string') => ({ path, type, editability: field.editability });
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    served('telemetry.enabled', 'boolean'), served('telemetry.destination', 'string'),
    served('telemetry.retention', 'string')] });
  const telemetryView: NativeConfigurationView = { ...view, fields: (['telemetry.enabled', 'telemetry.destination',
    'telemetry.retention'] as const).map(path => ({ path, catalog_path: path, explicit: { present: false as const },
    effective: { present: true as const, value: path === 'telemetry.enabled' ? false : null, source: 'compiled_default' as const },
    application: 'not_applied' as const })) };
  mount(telemetryView); await act(async () => {});
  const block = container.querySelector('[data-settings-item="native-configuration.telemetry"]') as HTMLElement;
  const pick = async (path: string) => { await act(async () => { const select = container.querySelector('select')!;
    select.value = path; select.dispatchEvent(new Event('change', { bubbles: true })); }); };
  const preview = () => [...container.querySelectorAll('button')]
    .find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  const type = async (value: string) => { await act(async () => {
    // The draft input lives in the shared editor below the block, so the text
    // input is page-global; pin the uniqueness this helper assumes.
    const inputs = [...container.querySelectorAll('input[type="text"]')];
    expect(inputs).toHaveLength(1);
    const input = inputs[0] as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); }); };
  await pick('telemetry.destination');
  await type('https://collector.example/v1');
  expect(preview().disabled).toBe(false);
  await type('https://user:secret@collector.example/v1');
  expect(preview().disabled).toBe(true);
  await type('ftp://collector.example/v1');
  expect(preview().disabled).toBe(true);
  await type('https://collector.example/v1');
  expect(preview().disabled).toBe(false);
  await pick('telemetry.retention');
  await type('');
  expect(preview().disabled).toBe(false);
  await pick('telemetry.enabled');
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  await act(async () => { checkbox.click(); });
  expect(checkbox.checked).toBe(true);
  expect(preview().disabled).toBe(false);
  await act(async () => { checkbox.click(); });
  expect(checkbox.checked).toBe(false);
  expect(preview().disabled).toBe(false);
});

it('edits persistence and the application prompt through the typed session block', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'persistence', type: 'enum' as const, enum: ['durable', 'ephemeral'], editability: field.editability },
    { path: 'application_system_prompt', type: 'string' as const, editability: field.editability }] });
  const promptView: NativeConfigurationView = { ...view, fields: ['persistence', 'application_system_prompt'].map(path => ({
    path, catalog_path: path, explicit: { present: false as const },
    effective: { present: true as const, value: path === 'persistence' ? 'durable' : '', source: 'compiled_default' as const },
    application: 'not_applied' as const })) };
  mount(promptView); await act(async () => {});
  const block = container.querySelector('[data-settings-item="native-configuration.prompt"]') as HTMLElement;
  expect([...block.querySelectorAll('button')].map(item => item.textContent)).toHaveLength(2);
  const pick = async (path: string) => { await act(async () => { const select = container.querySelector('select')!;
    select.value = path; select.dispatchEvent(new Event('change', { bubbles: true })); }); };
  const preview = () => [...container.querySelectorAll('button')]
    .find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  await pick('persistence');
  const persistenceSelect = [...container.querySelectorAll('select')]
    .find(item => [...item.querySelectorAll('option')].some(option => option.value === 'ephemeral')) as HTMLSelectElement;
  expect(persistenceSelect.value).toBe('durable');
  expect(preview().disabled).toBe(false);
  // The placeholder writes an invalid empty draft, so the gate blocks it.
  await act(async () => { persistenceSelect.value = '';
    persistenceSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(preview().disabled).toBe(true);
  await act(async () => { persistenceSelect.value = 'ephemeral';
    persistenceSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(preview().disabled).toBe(false);
  await pick('application_system_prompt');
  const area = container.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Be brief.');
    area.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(preview().disabled).toBe(false);
});

it('edits the recovery wall clock with zero-unset and the ordered ladder with its length rule', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'recovery.local_retry_limit', type: 'integer' as const, editability: field.editability },
    { path: 'recovery.turn_wall_clock_ms', type: 'integer' as const, editability: field.editability },
    { path: 'recovery.ladder', type: 'array' as const, editability: field.editability }] });
  const recoveryView: NativeConfigurationView = { ...view, fields: [
    { path: 'recovery.local_retry_limit', catalog_path: 'recovery.local_retry_limit', explicit: { present: false as const },
      effective: { present: true as const, value: 3, source: 'compiled_default' as const }, application: 'not_applied' as const },
    { path: 'recovery.ladder', catalog_path: 'recovery.ladder', explicit: { present: false as const },
      effective: { present: true as const, value: ['nudge', 'compact', 'compact'], source: 'compiled_default' as const },
      application: 'not_applied' as const },
    { path: 'recovery.turn_wall_clock_ms', catalog_path: 'recovery.turn_wall_clock_ms', explicit: { present: false as const },
      effective: { present: false as const }, application: 'not_applied' as const }] };
  mount(recoveryView); await act(async () => {});
  const pick = async (path: string) => { await act(async () => { const select = container.querySelector('select')!;
    select.value = path; select.dispatchEvent(new Event('change', { bubbles: true })); }); };
  const preview = () => [...container.querySelectorAll('button')]
    .find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  await pick('recovery.turn_wall_clock_ms');
  const type = async (value: string) => { await act(async () => {
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); }); };
  await type('0');
  expect(preview().disabled).toBe(false);
  await type('500');
  expect(preview().disabled).toBe(true);
  await type('90000');
  expect(preview().disabled).toBe(false);
  await pick('recovery.ladder');
  expect(container.textContent).toContain('nudge');
  expect(container.textContent).toContain('compact');
  const removeStep = () => [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === 'Remove step') as HTMLButtonElement;
  expect([...container.querySelectorAll('button')].filter(item => item.getAttribute('aria-label') === 'Remove step')).toHaveLength(3);
  await act(async () => { removeStep().click(); });
  expect(preview().disabled).toBe(false);
  await act(async () => { removeStep().click(); });
  expect(preview().disabled).toBe(true);
  const addCompact = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add compact') as HTMLButtonElement;
  await act(async () => { addCompact.click(); });
  expect(preview().disabled).toBe(false);
  // The generic JSON textarea stays suppressed while the ladder editor is up.
  expect(container.querySelector('textarea')).toBeNull();
  const chipButton = (label: string, at: number) => [...container.querySelectorAll('button')]
    .filter(item => item.getAttribute('aria-label') === label)[at] as HTMLButtonElement;
  expect(chipButton('Move up', 0).disabled).toBe(true);
  expect(chipButton('Move up', 1).disabled).toBe(false);
  expect(chipButton('Move down', 0).disabled).toBe(false);
  await act(async () => { chipButton('Move down', 0).click(); });
  // After the move the former second chip sits last, so its move-down locks.
  expect(chipButton('Move down', 1).disabled).toBe(true);
  const addNudge = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add nudge') as HTMLButtonElement;
  await act(async () => { addNudge.click(); });
  const addCompactNow = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add compact') as HTMLButtonElement;
  await act(async () => { addCompactNow.click(); });
  expect(chipButton('Move up', 0).disabled).toBe(true);
  expect(([...container.querySelectorAll('button')].find(item => item.textContent === 'Add nudge') as HTMLButtonElement).disabled)
    .toBe(true);
  expect(([...container.querySelectorAll('button')].find(item => item.textContent === 'Add compact') as HTMLButtonElement).disabled)
    .toBe(true);
});
