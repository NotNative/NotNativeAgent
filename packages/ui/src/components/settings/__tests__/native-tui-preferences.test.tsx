// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { requestNativeConfiguration, type NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { nativeChange, previewNativeConfiguration, requestNativeConfigurationCatalog,
  saveNativeConfiguration, lookupNativeConfigurationOperation } from '../../../lib/nnd/configuration-mutation.ts';
import { NativeConfigurationControls } from '../pages/native-configuration-controls.tsx';
import { NativeTuiPreferencesPage } from '../pages/native-tui-preferences.tsx';

vi.mock('../../../lib/nnd/configuration.ts', () => ({ requestNativeConfiguration: vi.fn() }));
vi.mock('../../../lib/runtime-switch.ts', async importOriginal => ({ ...(await importOriginal<object>()),
  getRuntimeKey: () => 'local' }));
vi.mock('../../../lib/runtime-url.ts', async importOriginal => ({ ...(await importOriginal<object>()),
  getApiBaseUrl: () => 'http://127.0.0.1:3000' }));
vi.mock('../../../lib/nnd/configuration-mutation.ts', () => ({ requestNativeConfigurationCatalog: vi.fn(),
  NativeConfigurationFailure: class NativeConfigurationFailure extends Error { constructor(readonly code: string) { super(code); } },
  nativeChange: vi.fn(), newNativeOperationId: vi.fn(() => 'operation_1'), previewNativeConfiguration: vi.fn(),
  saveNativeConfiguration: vi.fn(), lookupNativeConfigurationOperation: vi.fn() }));

const revision = 'a'.repeat(64), resolution = 'b'.repeat(64);
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test',
  scope: 'user', source_state: 'present', source_revision: revision, resolution_revision: resolution,
  source_revisions: [], application: 'not_applied', fields: [
    { path: 'tui.key_bindings.submit', catalog_path: 'tui.key_bindings.submit', explicit: { present: false },
      effective: { present: true, value: 'Enter', source: 'compiled_default' }, application: 'not_applied' },
    { path: 'tui.color', catalog_path: 'tui.color', explicit: { present: true, value: true },
      effective: { present: true, value: true, source: 'user' }, application: 'not_applied' },
  ] };
const field = (path: string, type: 'string' | 'boolean') => ({ path, type,
  editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } });
const request = { installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
  expected_revision: revision, expected_resolution_revision: resolution,
  operations: [{ op: 'set' as const, field: 'tui.key_bindings.submit', value: 'ctrl+x' }] };
let root: Root; let container: HTMLDivElement;
function mount() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(<I18nProvider><NativeConfigurationControls view={view} onReload={vi.fn()} family="tui" /></I18nProvider>));
}
function mountPage() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(<I18nProvider><NativeTuiPreferencesPage /></I18nProvider>));
}
function button(label: string) { const found = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!found) throw new Error('button missing: ' + label); return found; }
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear();
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [field('tui.color', 'boolean'),
    field('tui.key_bindings.submit', 'string'), field('memory.enabled', 'boolean')] }); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); sessionStorage.clear(); });

it('offers only supported TUI fields and previews a typed key binding before native save', async () => {
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: revision, application: 'not_applied', replayed: false });
  mount(); await act(async () => {});
  expect([...container.querySelectorAll('option')].map(option => option.value)).not.toContain('memory.enabled');
  await act(async () => { const select = container.querySelector('select')!; select.value = 'tui.key_bindings.submit';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Enter');
  await act(async () => { const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'ctrl+x'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).not.toContain('Save to NNA');
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(view, expect.objectContaining({ path: 'tui.key_bindings.submit' }),
    'set', JSON.stringify('ctrl+x'));
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(request, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved');
});

it('shows the native installation, data, and source revision before editing TUI settings', async () => {
  vi.mocked(requestNativeConfiguration).mockResolvedValue(view);
  mountPage(); await act(async () => {});
  expect(container.textContent).toContain(view.installation_id);
  expect(container.textContent).toContain(view.data_id);
  expect(container.textContent).toContain(revision);
});

it('keeps an uncertain TUI save operation for receipt lookup instead of resubmitting', async () => {
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view });
  vi.mocked(saveNativeConfiguration).mockRejectedValue(new Error('connection dropped'));
  vi.mocked(lookupNativeConfigurationOperation).mockResolvedValue(null);
  mount(); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'tui.key_bindings.submit';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  await act(async () => button('Save to NNA').click());
  expect(container.textContent).toContain('operation_1');
  expect(button('Preview change').disabled).toBe(true);
  await act(async () => button('Inspect operation').click());
  expect(lookupNativeConfigurationOperation).toHaveBeenCalledWith(view, 'operation_1', expect.any(AbortSignal));
  expect(saveNativeConfiguration).toHaveBeenCalledTimes(1);
});
