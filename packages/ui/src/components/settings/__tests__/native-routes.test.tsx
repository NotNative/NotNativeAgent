// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { requestNativeConfiguration, type NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { nativeChange, nativeRouteBindingChange, previewNativeConfiguration, requestNativeConfigurationCatalog,
  saveNativeConfiguration } from '../../../lib/nnd/configuration-mutation.ts';
import { NativeRoutesPage } from '../pages/native-routes.tsx';

vi.mock('../../../lib/nnd/configuration.ts', () => ({ requestNativeConfiguration: vi.fn() }));
const runtime = vi.hoisted(() => ({ key: 'local', callback: () => {} }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()),
  getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: (callback: () => void) => { runtime.callback = callback; return () => { runtime.callback = () => {}; }; } }));
vi.mock('../../../lib/runtime-url.ts', async original => ({ ...(await original<object>()), getApiBaseUrl: () => 'http://127.0.0.1:3000' }));
vi.mock('../../../lib/nnd/configuration-mutation.ts', () => ({ requestNativeConfigurationCatalog: vi.fn(),
  NativeConfigurationFailure: class NativeConfigurationFailure extends Error { constructor(readonly code: string) { super(code); } },
  nativeChange: vi.fn(), nativeRouteBindingChange: vi.fn(), newNativeOperationId: vi.fn(() => 'operation_1'), previewNativeConfiguration: vi.fn(),
  saveNativeConfiguration: vi.fn(), lookupNativeConfigurationOperation: vi.fn() }));

const revision = 'a'.repeat(64), resolution = 'b'.repeat(64);
const row = (path: string, value: string | number) => ({ path, catalog_path: path, explicit: { present: true as const, value },
  effective: { present: true as const, value, source: 'user' }, application: 'not_applied' as const });
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test',
  scope: 'user', source_state: 'present', source_revision: revision, resolution_revision: resolution,
  source_revisions: [], application: 'not_applied', fields: [row('routes.reviewer.provider_id', 'local'),
    row('routes.reviewer.model', 'review-model'), row('routes.vision.provider_id', 'visual'),
    row('routes.vision.model', 'image-model'), row('routes.reviewer.temperature', 0.4),
    row('routes.vision.temperature', 0.2), row('memory.enabled', 'true'),
    row('providers[local].id', 'local'), row('providers[local].model', 'base'),
    row('providers[visual].id', 'visual'), row('providers[visual].model', 'image-base')] };
const editable = (path: string, type: 'number' | 'string') => ({ path, type,
  editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } });
let root: Root; let container: HTMLDivElement;
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!found) throw new Error('Missing button: ' + label); return found;
}
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  runtime.key = 'local'; runtime.callback = () => {};
  vi.mocked(requestNativeConfiguration).mockResolvedValue(view);
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [editable('routes.reviewer.temperature', 'number'),
    editable('routes.vision.temperature', 'number'), editable('routes.reviewer.provider_id', 'string'),
    editable('memory.enabled', 'string')], routeBindings: ['reviewer', 'vision'] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); sessionStorage.clear(); });

it('shows reviewer and vision bindings with paired native editing while keeping scalar fields separate', async () => {
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  await act(async () => {});
  expect(container.textContent).toContain('review-model');
  expect(container.textContent).toContain('image-model');
  expect(container.textContent).toContain('paired native binding');
  expect(container.textContent).toContain('not applied');
  const options = [...container.querySelectorAll('option')].map(option => option.value);
  expect(options).toContain('routes.reviewer.temperature');
  expect(options).toContain('routes.vision.temperature');
  expect(options).not.toContain('routes.reviewer.provider_id');
  expect(options).not.toContain('memory.enabled');
});

it('previews and saves one paired reviewer provider/model binding with native CAS and receipt', async () => {
  const request = { installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: 'bind_route' as const, role: 'reviewer' as const, provider_id: 'visual', model: 'review-vision' }] };
  vi.mocked(nativeRouteBindingChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view: { ...view, fields: [
      ...view.fields.filter(row => row.path !== 'routes.reviewer.provider_id' && row.path !== 'routes.reviewer.model'),
      row('routes.reviewer.provider_id', 'visual'), row('routes.reviewer.model', 'review-vision')] } });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: revision, application: 'not_applied', replayed: false });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const binding = container.querySelector('[aria-label="Provider and model binding"]')!;
  await act(async () => { const select = binding.querySelector('[aria-label="Binding provider"]') as HTMLSelectElement;
    select.value = 'visual'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { const input = binding.querySelector('[aria-label="Binding model"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'review-vision');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => (binding.querySelector('button') as HTMLButtonElement).click());
  expect(nativeRouteBindingChange).toHaveBeenCalledWith(view, expect.objectContaining({ routeBindings: ['reviewer', 'vision'] }),
    'reviewer', 'visual', 'review-vision');
  expect(previewNativeConfiguration).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  expect(binding.textContent).toContain('review-vision');
  await act(async () => [...binding.querySelectorAll('button')].find(button => button.textContent?.includes('Save to NNA'))!.click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(request, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved');
  expect(container.textContent).toContain('not applied');
});

it('keeps a shadowed vision binding unsaved and shows the native conflict', async () => {
  vi.mocked(nativeRouteBindingChange).mockReturnValue({ installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: 'bind_route', role: 'vision', provider_id: 'visual', model: 'image-model' }] });
  vi.mocked(previewNativeConfiguration).mockRejectedValue(Object.assign(new Error('shadowed'),
    { code: 'configuration_source_shadowed' }));
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const binding = container.querySelector('[aria-label="Provider and model binding"]')!;
  await act(async () => { const select = binding.querySelector('[aria-label="Route to bind"]') as HTMLSelectElement;
    select.value = 'vision'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => (binding.querySelector('button') as HTMLButtonElement).click());
  expect(container.textContent).toContain('configuration_source_shadowed');
  expect(saveNativeConfiguration).not.toHaveBeenCalled();
  expect([...binding.querySelectorAll('button')].some(button => button.textContent?.includes('Save to NNA'))).toBe(false);
});

it('uses native preview and save for reviewer scalar with selected CAS identity', async () => {
  const request = { installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: 'set' as const, field: 'routes.reviewer.temperature', value: 0.5 }] };
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view });
  vi.mocked(saveNativeConfiguration).mockResolvedValue({ installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', operation_id: 'operation_1', persistence: 'saved', persisted_revision: 'c'.repeat(64),
    before_revision: revision, application: 'not_applied', replayed: false });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  await act(async () => { const select = container.querySelector('select')!; select.value = 'routes.reviewer.temperature';
    select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { const area = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '0.5');
    area.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(view, expect.objectContaining({ path: 'routes.reviewer.temperature' }), 'set', '0.5');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(request, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved');
});

it('discards a late route view from the old runtime after switching NNA', async () => {
  let finish!: (value: NativeConfigurationView) => void;
  vi.mocked(requestNativeConfiguration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ...view, installation_id: 'nna_other', data_id: 'data_other' });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  const oldSignal = vi.mocked(requestNativeConfiguration).mock.calls[0]![0];
  await act(async () => { runtime.key = 'host:other'; runtime.callback(); });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(view));
  expect(container.textContent).toContain('nna_other');
  expect(container.textContent).not.toContain(view.installation_id);
});
