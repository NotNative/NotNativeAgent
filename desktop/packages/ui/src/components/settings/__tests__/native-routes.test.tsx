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
const row = (path: string, value: string | number | boolean | string[]) => ({ path, catalog_path: path, explicit: { present: true as const, value },
  effective: { present: true as const, value, source: 'user' }, application: 'not_applied' as const });
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test',
  scope: 'user', source_state: 'present', source_revision: revision, resolution_revision: resolution,
  source_revisions: [], application: 'not_applied', fields: [row('routes.primary.provider_id', 'local'),
    row('routes.primary.model', 'primary-model'), row('routes.subagent.provider_id', 'cheap'),
    row('routes.subagent.model', 'sub-model'), row('routes.reviewer.provider_id', 'local'),
    row('routes.reviewer.model', 'review-model'), row('routes.vision.provider_id', 'visual'),
    row('routes.vision.model', 'image-model'), row('routes.reviewer.temperature', 0.4),
    row('routes.vision.temperature', 0.2), row('memory.enabled', 'true'),
    row('providers[local].id', 'local'), row('providers[local].model', 'base'),
    row('providers[visual].id', 'visual'), row('providers[visual].model', 'image-base')] };
const editable = (path: string, type: 'number' | 'string' | 'boolean' | 'enum' | 'integer') => ({ path, type,
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

it('shows all four route bindings with the authority that actually changes each one', async () => {
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  await act(async () => {});
  const card = (role: string) => container.querySelector(`[data-testid="route-binding-${role}"]`)?.textContent ?? '';
  // NNA resolves every role in contracts.js ROLES and the read view projects each one,
  // so the page may not show only the two roles the desktop is allowed to rebind.
  expect(card('primary')).toContain('local');
  expect(card('primary')).toContain('primary-model');
  expect(card('subagent')).toContain('cheap');
  expect(card('subagent')).toContain('sub-model');
  // The notes must not promise an editor that NNA does not offer for these roles.
  expect(card('primary')).toContain('primary model in Connections');
  expect(card('subagent')).toContain('Subagent model binding below');
  expect(card('reviewer')).toContain('paired native binding');
  expect(card('vision')).toContain('paired native binding');
});

it('renders a role whose binding the view does not carry as no value rather than a blank', async () => {
  vi.mocked(requestNativeConfiguration).mockResolvedValue({
    ...view, fields: view.fields.filter(field => field.path !== 'routes.subagent.provider_id'),
  } as never);
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  await act(async () => {});
  const card = container.querySelector('[data-testid="route-binding-subagent"]')?.textContent ?? '';
  expect(card).toContain('sub-model');
  expect(card).toContain('—');
});

it('renders every served member of each route role beside its binding pair', async () => {
  // The route container is on screen only when this card renders everything
  // the role holds (the 20261007-57 record-container rule): NNA serves eleven
  // members per role (test/nnd-configuration-view.test.js "the route family
  // serves inherited bindings, canonical zeros, and its own availability
  // gate"), so the card lists all of them with their declared raw value and
  // their resolved value with provenance — including the members the paired
  // editors do not touch (required_capabilities, fallbacks) and the canonical
  // zeros and inherited provenance NNA's own test pins.
  const fields = [
    ...['primary', 'reviewer', 'subagent', 'vision'].flatMap(role => ([
      row(`routes.${role}.provider_id`, role === 'primary' ? 'local' : 'local'), row(`routes.${role}.model`, role === 'primary' ? 'primary-model' : 'base'),
      row(`routes.${role}.deadline_ms`, 0),
      { path: `routes.${role}.context_limit_bytes`, catalog_path: `routes.${role}.context_limit_bytes`,
        explicit: { present: true as const, value: null }, effective: { present: true as const, value: null, source_unavailable: true },
        application: 'not_applied' as const },
      { path: `routes.${role}.required_capabilities`, catalog_path: `routes.${role}.required_capabilities`,
        explicit: { present: true as const, value: ['tools'] }, effective: { present: true as const, value: ['tools'], source: 'user' },
        application: 'not_applied' as const },
      { path: `routes.${role}.temperature`, catalog_path: `routes.${role}.temperature`,
        explicit: { present: false as const }, effective: { present: true as const, value: null, source: 'compiled_default' },
        application: 'not_applied' as const },
      { path: `routes.${role}.max_output_tokens`, catalog_path: `routes.${role}.max_output_tokens`,
        explicit: { present: false as const }, effective: { present: true as const, value: null, source: 'compiled_default' },
        application: 'not_applied' as const },
      { path: `routes.${role}.budget`, catalog_path: `routes.${role}.budget`,
        explicit: { present: false as const }, effective: { present: true as const, value: null, source: 'compiled_default' },
        application: 'not_applied' as const },
      { path: `routes.${role}.fallbacks`, catalog_path: `routes.${role}.fallbacks`,
        explicit: { present: false as const }, effective: { present: true as const, value: [], source_unavailable: true },
        application: 'not_applied' as const },
      { path: `routes.${role}.reasoning_effort`, catalog_path: `routes.${role}.reasoning_effort`,
        explicit: { present: false as const }, effective: { present: true as const, value: null, source: 'compiled_default' },
        application: 'not_applied' as const },
      { path: `routes.${role}.enable_thinking`, catalog_path: `routes.${role}.enable_thinking`,
        explicit: { present: false as const }, effective: { present: true as const, value: null, source: 'compiled_default' },
        application: 'not_applied' as const },
    ])),
    row('providers[local].id', 'local'), row('providers[local].model', 'base'),
  ] as never;
  vi.mocked(requestNativeConfiguration).mockResolvedValue({ ...view, fields } as never);
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  await act(async () => {});
  const card = (role: string) => container.querySelector(`[data-testid="route-binding-${role}"]`)?.textContent ?? '';
  for (const role of ['primary', 'reviewer', 'subagent', 'vision']) {
    // Every member the container holds is rendered in this unit, by name.
    for (const key of ['provider_id', 'model', 'context_limit_bytes', 'required_capabilities', 'temperature',
      'max_output_tokens', 'budget', 'fallbacks', 'deadline_ms', 'reasoning_effort', 'enable_thinking']) {
      expect(card(role), `routes.${role}.${key}`).toContain(`routes.${role}.${key}`);
    }
    // The shapes NNA's own test pins are shown verbatim: the canonical zero
    // deadline, the null unset limits, the fallbacks and required
    // capabilities arrays, and per-member provenance (resolved with its
    // layer, inherited/derived marked Unavailable, unset defaults compiled).
    expect(card(role)).toContain('0');
    expect(card(role)).toContain('null');
    expect(card(role)).toContain('["tools"]');
    expect(card(role)).toContain('[]');
    expect(card(role)).toContain('user');
    expect(card(role)).toContain('compiled_default');
    expect(card(role)).toContain('Unavailable');
  }
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
  await act(async () => { const area = container.querySelector('input[type="number"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(area, '0.5');
    area.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Preview change').click());
  expect(nativeChange).toHaveBeenCalledWith(view, expect.objectContaining({ path: 'routes.reviewer.temperature' }), 'set', '0.5');
  await act(async () => button('Save to NNA').click());
  expect(saveNativeConfiguration).toHaveBeenCalledWith(request, 'operation_1', expect.any(AbortSignal));
  expect(container.textContent).toContain('saved');
});

it('types boolean and enum route scalars from the catalog and gates bad numbers', async () => {
  const enumField = { path: 'routes.vision.reasoning_effort', type: 'enum' as const,
    enum: ['minimal', 'low', 'medium', 'high'],
    editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } };
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    editable('routes.reviewer.enable_thinking', 'boolean'), enumField, editable('routes.reviewer.budget', 'integer'),
    editable('routes.reviewer.deadline_ms', 'integer'), editable('routes.reviewer.provider_id', 'string')],
    routeBindings: ['reviewer', 'vision'] });
  const liveView = { ...view, fields: [...view.fields,
    row('routes.reviewer.enable_thinking', true), row('routes.vision.reasoning_effort', 'medium'),
    row('routes.reviewer.budget', 4), row('routes.reviewer.deadline_ms', 0)] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(liveView);
  vi.mocked(nativeChange).mockImplementation((_view, field, mode, draft) => ({
    installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: mode === 'reset' ? 'reset' : 'set', field: field.path,
      ...(mode === 'set' ? { value: JSON.parse(draft) } : {}) }] }));
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const tuning = container.querySelector('[data-settings-item="native-routes.tuning"]')!;
  const chooser = tuning.querySelector('select') as HTMLSelectElement;
  const preview = () => [...tuning.querySelectorAll('button')].find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  const pick = async (path: string) => { await act(async () => { chooser.value = path;
    chooser.dispatchEvent(new Event('change', { bubbles: true })); }); };
  await pick('routes.reviewer.enable_thinking');
  const checkbox = tuning.querySelector('input[type="checkbox"]') as HTMLInputElement;
  // The stored value is true, so the control renders checked: the seed comes
  // from the row, not from a blank.
  expect(checkbox.checked).toBe(true);
  await act(async () => { checkbox.click(); });
  expect(checkbox.checked).toBe(false);
  await act(async () => preview().click());
  expect(nativeChange).toHaveBeenCalledWith(liveView, expect.objectContaining({ path: 'routes.reviewer.enable_thinking' }), 'set', 'false');
  await pick('routes.vision.reasoning_effort');
  const enumSelect = [...tuning.querySelectorAll('select')]
    .find(select => [...select.querySelectorAll('option')].some(option => option.value === 'minimal')) as HTMLSelectElement;
  expect([...enumSelect.querySelectorAll('option')].map(option => option.value).filter(Boolean))
    .toEqual(['minimal', 'low', 'medium', 'high']);
  await act(async () => { enumSelect.value = 'low'; enumSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => preview().click());
  expect(nativeChange).toHaveBeenCalledWith(liveView, expect.objectContaining({ path: 'routes.vision.reasoning_effort' }), 'set', '"low"');
  await pick('routes.reviewer.budget');
  const numberInput = tuning.querySelector('input[type="number"]') as HTMLInputElement;
  const type = async (value: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numberInput, value);
    numberInput.dispatchEvent(new Event('input', { bubbles: true })); }); };
  await type('999');
  expect(preview().disabled).toBe(true);
  expect(nativeChange).not.toHaveBeenCalledWith(liveView, expect.objectContaining({ path: 'routes.reviewer.budget' }), expect.anything(), '999');
  await type('8');
  expect(preview().disabled).toBe(false);
  await act(async () => preview().click());
  expect(nativeChange).toHaveBeenCalledWith(liveView, expect.objectContaining({ path: 'routes.reviewer.budget' }), 'set', '8');
  await type('4.5');
  expect(preview().disabled).toBe(true);
  await pick('routes.reviewer.deadline_ms');
  await type('0');
  expect(preview().disabled).toBe(false);
  await act(async () => preview().click());
  expect(nativeChange).toHaveBeenCalledWith(liveView, expect.objectContaining({ path: 'routes.reviewer.deadline_ms' }), 'set', '0');
});

it('edits reviewer capability and fallback lists as ordered unique chips', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    { path: 'routes.reviewer.required_capabilities', type: 'array' as const,
      editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } },
    { path: 'routes.reviewer.fallbacks', type: 'array' as const,
      editability: { available: true as const, scope: 'user' as const, required_permission: 'nnd.configuration.manage' as const } },
    editable('routes.reviewer.provider_id', 'string')], routeBindings: ['reviewer', 'vision'] });
  const arrayView = { ...view, fields: [...view.fields,
    row('routes.reviewer.required_capabilities', ['tools']), row('routes.reviewer.fallbacks', ['vision'])] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(arrayView);
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const tuning = container.querySelector('[data-settings-item="native-routes.tuning"]')!;
  const chooser = tuning.querySelector('select') as HTMLSelectElement;
  const preview = () => [...tuning.querySelectorAll('button')].find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  const pick = async (path: string) => { await act(async () => { chooser.value = path;
    chooser.dispatchEvent(new Event('change', { bubbles: true })); }); };
  const add = (label: string) => [...tuning.querySelectorAll('button')]
    .find(item => item.textContent === `Add ${label}`) as HTMLButtonElement;
  await pick('routes.reviewer.fallbacks');
  expect(preview().disabled).toBe(false);
  await act(async () => { add('primary').click(); });
  expect(preview().disabled).toBe(false);
  // Order is the point: move the appended role to the front and preview it.
  const chipButton = (label: string, at: number) => [...tuning.querySelectorAll('button')]
    .filter(item => item.getAttribute('aria-label') === label)[at] as HTMLButtonElement;
  expect(chipButton('Move up', 0).disabled).toBe(true);
  await act(async () => { chipButton('Move up', 1).click(); });
  vi.mocked(nativeChange).mockImplementation((_view, field, mode, draft) => ({
    installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: 'set' as const, field: field.path, value: JSON.parse(draft) }] }));
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view });
  await act(async () => preview().click());
  expect(nativeChange).toHaveBeenCalledWith(arrayView, expect.objectContaining({ path: 'routes.reviewer.fallbacks' }),
    'set', '["primary","vision"]');
  // Uniqueness: an already-present entry cannot be appended again.
  expect(add('primary').disabled).toBe(true);
  expect(add('vision').disabled).toBe(true);
  await act(async () => { add('reviewer').click(); });
  const addSubagent = [...tuning.querySelectorAll('button')].find(item => item.textContent === 'Add subagent') as HTMLButtonElement;
  await act(async () => { addSubagent.click(); });
  // Four fallback roles fill the cap.
  expect(add('primary').disabled).toBe(true);
  expect(preview().disabled).toBe(false);
  const removeEntry = () => [...tuning.querySelectorAll('button')]
    .find(item => item.getAttribute('aria-label') === 'Remove entry') as HTMLButtonElement;
  for (let at = 0; at < 4; at++) await act(async () => { removeEntry().click(); });
  // An empty fallback list is legal.
  expect(preview().disabled).toBe(false);
  await pick('routes.reviewer.required_capabilities');
  const addTools = [...tuning.querySelectorAll('button')].find(item => item.textContent === 'Add tools') as HTMLButtonElement;
  await act(async () => { addTools.click(); });
  const addImages = [...tuning.querySelectorAll('button')].find(item => item.textContent === 'Add images') as HTMLButtonElement;
  await act(async () => { addImages.click(); });
  expect(preview().disabled).toBe(false);
  // Only the served capability list offers add buttons.
  expect([...tuning.querySelectorAll('button')].some(item => item.textContent === 'Add streaming')).toBe(true);
  expect([...tuning.querySelectorAll('button')].some(item => item.textContent === 'Add nudge')).toBe(false);
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

it('offers exactly the route rows NNA advertises and none it leaves unbound', async () => {
  // NNA's catalog decides the offer: the seven scalar members plus the two
  // list members are tuned here for every role — src/nnd-configuration-intents.js
  // admits generic writes for routes.{role} regardless of role (the one
  // caveat: a generic write for routes.primary.deadline_ms normalizes onto
  // the canonical provider_timeout_ms pair, the alias never persists) — while
  // the provider/model pair never enters this chooser: primary and subagent
  // bind through the provider route authority and reviewer/vision through the
  // paired binding form below. The primary deadline keeps its typed control in
  // the provider-deadline block on the native configuration page, which
  // previews the global timeout beside it.
  const tuning = ['budget', 'context_limit_bytes', 'deadline_ms', 'enable_thinking', 'max_output_tokens',
    'reasoning_effort', 'temperature'];
  const roles = ['primary', 'reviewer', 'subagent', 'vision'];
  const paths = roles.flatMap(role => [...tuning.map(key => `routes.${role}.${key}`),
    `routes.${role}.required_capabilities`, `routes.${role}.fallbacks`, `routes.${role}.provider_id`,
    `routes.${role}.model`]);
  vi.mocked(requestNativeConfiguration).mockResolvedValue({ ...view,
    fields: [...view.fields.filter(field => !field.path.startsWith('routes.')),
      ...paths.map(path => row(path, 'value'))] });
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({
    fields: paths.map(path => ({ path, type: path.endsWith('temperature') ? 'number' as const
      : path.endsWith('required_capabilities') || path.endsWith('fallbacks') ? 'array' as const : 'integer' as const,
      editability: { available: true as const, scope: 'user' as const,
        required_permission: 'nnd.configuration.manage' as const } })),
    routeBindings: ['reviewer', 'vision'] });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>));
  await act(async () => {});
  const options = [...container.querySelectorAll('option')].map(option => option.value);
  for (const role of roles) for (const key of tuning) {
    if (role === 'primary' && key === 'deadline_ms') continue;
    expect(options, `routes.${role}.${key}`).toContain(`routes.${role}.${key}`);
  }
  for (const role of roles) for (const key of ['required_capabilities', 'fallbacks']) {
    expect(options, `routes.${role}.${key}`).toContain(`routes.${role}.${key}`);
  }
  // The binding pair is never a scalar choice here, and the primary deadline
  // belongs to the provider-deadline block that shows the pair it overrides.
  expect(options).not.toContain('routes.primary.deadline_ms');
  for (const role of roles) {
    expect(options, `routes.${role}.provider_id`).not.toContain(`routes.${role}.provider_id`);
    expect(options, `routes.${role}.model`).not.toContain(`routes.${role}.model`);
  }
  expect(options.filter(value => value.startsWith('routes.'))).toHaveLength(35);
  const roleSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Route to bind"]');
  expect(roleSelect).not.toBeNull();
  expect([...roleSelect!.querySelectorAll('option')].map(option => option.value).filter(Boolean))
    .toEqual(['reviewer', 'vision']);
});

it('refuses an out-of-range subagent budget before the wire and surfaces NNA’s refusal when the native preview rejects', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    editable('routes.subagent.budget', 'integer'), editable('routes.subagent.provider_id', 'string')],
    routeBindings: ['reviewer', 'vision'] });
  const liveView = { ...view, fields: [...view.fields, row('routes.subagent.budget', 4)] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(liveView);
  vi.mocked(nativeChange).mockImplementation((_view, field, mode, draft) => ({
    installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: mode === 'reset' ? 'reset' : 'set', field: field.path,
      ...(mode === 'set' ? { value: JSON.parse(draft) } : {}) }] }));
  // The native preview refuses when a higher-precedence source owns the field
  // (src/nnd-configuration-service.js candidate() throws
  // configuration_source_shadowed); the desktop echoes NNA's own code.
  vi.mocked(previewNativeConfiguration).mockRejectedValue(Object.assign(new Error('shadowed'),
    { code: 'configuration_source_shadowed' }));
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const tuning = container.querySelector('[data-settings-item="native-routes.tuning"]')!;
  const chooser = tuning.querySelector('select') as HTMLSelectElement;
  await act(async () => { chooser.value = 'routes.subagent.budget';
    chooser.dispatchEvent(new Event('change', { bubbles: true })); });
  const preview = () => [...tuning.querySelectorAll('button')].find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  const numberInput = tuning.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numberInput, '999');
    numberInput.dispatchEvent(new Event('input', { bubbles: true })); });
  // Mirror bound (configuration-rules.js budget 1–64) refuses before the wire.
  expect(preview().disabled).toBe(true);
  expect(previewNativeConfiguration).not.toHaveBeenCalled();
  expect(nativeChange).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numberInput, '8');
    numberInput.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(preview().disabled).toBe(false);
  await act(async () => preview().click());
  expect(previewNativeConfiguration).toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('configuration_source_shadowed');
  expect(container.textContent).not.toContain('Save to NNA');
});

it('surfaces a revision conflict on a subagent save and keeps the draft for reconciliation', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    editable('routes.subagent.budget', 'integer'), editable('routes.subagent.provider_id', 'string')],
    routeBindings: ['reviewer', 'vision'] });
  const request = { installation_id: view.installation_id, data_id: view.data_id, scope: 'user' as const,
    expected_revision: revision, expected_resolution_revision: resolution,
    operations: [{ op: 'set' as const, field: 'routes.subagent.budget', value: 8 }] };
  vi.mocked(nativeChange).mockReturnValue(request);
  vi.mocked(previewNativeConfiguration).mockResolvedValue({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', view: { ...view, fields: [...view.fields,
      row('routes.subagent.budget', 8)] } });
  vi.mocked(saveNativeConfiguration).mockRejectedValue(Object.assign(new Error('conflict'),
    { code: 'manifest_revision_conflict' }));
  vi.mocked(requestNativeConfiguration).mockResolvedValue({ ...view,
    fields: [...view.fields, row('routes.subagent.budget', 4)] });
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const tuning = container.querySelector('[data-settings-item="native-routes.tuning"]')!;
  const chooser = tuning.querySelector('select') as HTMLSelectElement;
  await act(async () => { chooser.value = 'routes.subagent.budget';
    chooser.dispatchEvent(new Event('change', { bubbles: true })); });
  const numberInput = tuning.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numberInput, '8');
    numberInput.dispatchEvent(new Event('input', { bubbles: true })); });
  const preview = () => [...tuning.querySelectorAll('button')].find(item => item.textContent?.includes('Preview change')) as HTMLButtonElement;
  await act(async () => preview().click());
  // The preview names both sides before save: the persisted value and the
  // value NNA resolves from it.
  expect(container.textContent).toContain('Explicit: 8');
  expect(container.textContent).toContain('Effective: 8');
  await act(async () => [...tuning.querySelectorAll('button')].find(item => item.textContent?.includes('Save to NNA'))!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('manifest_revision_conflict');
  // The conflict does not swallow the operator's typed draft.
  expect((tuning.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('8');
  expect(container.textContent).toContain('routes.subagent.budget');
});

it('hides a route member the native catalog does not advertise', async () => {
  vi.mocked(requestNativeConfigurationCatalog).mockResolvedValue({ fields: [
    editable('routes.subagent.temperature', 'number'), editable('routes.subagent.provider_id', 'string')],
    routeBindings: ['reviewer', 'vision'] });
  const liveView = { ...view, fields: [...view.fields, row('routes.subagent.temperature', 0.3),
    row('routes.subagent.budget', 4), row('routes.subagent.fallbacks', ['vision'] as string[])] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(liveView);
  act(() => root.render(<I18nProvider><NativeRoutesPage /></I18nProvider>)); await act(async () => {});
  const options = [...container.querySelectorAll('option')].map(option => option.value);
  expect(options).toContain('routes.subagent.temperature');
  // Advertised nowhere, offered nowhere: the unbudgeted and list members stay out.
  expect(options).not.toContain('routes.subagent.budget');
  expect(options).not.toContain('routes.subagent.fallbacks');
});
