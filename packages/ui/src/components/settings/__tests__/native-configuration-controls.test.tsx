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
