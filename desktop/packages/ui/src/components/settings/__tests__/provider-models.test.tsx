// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderModels } from '../pages/provider-models.tsx';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { installNativeSettingsWriter, useSettingsStore } from '../../../lib/settings/store.ts';
import { useNativePreferenceState } from '../../../lib/settings/native-preferences.ts';
import { catalogOwner, rememberCatalog, useModelCatalog } from '../../../chat/configured-model-catalog.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, off: () => void;
const saved = vi.fn(), write = vi.fn();
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.querySelector('#root')!);
  useSettingsStore.setState({ doc: { favoriteModels: [], hiddenModels: [] }, loading: false });
  useNativePreferenceState.setState({ status: 'saved', error: '' });
  useModelCatalog.setState({ owner: catalogOwner(), models: {} });
  off = installNativeSettingsWriter((key, value) => { write(key, value); useSettingsStore.setState({ doc: { ...useSettingsStore.getState().doc, [key]: value } }); });
  vi.spyOn(harnessClient, 'discoverProviderModels').mockResolvedValue({ data: { profile_id: 'one', models: ['saved', 'extra'] } } as never);
  vi.spyOn(harnessClient, 'testProviderProfile').mockResolvedValue({ data: { profile_id: 'one', status: 'ready', selected_model: 'saved', discovered_models: 2 } } as never);
});
afterEach(() => { act(() => root.unmount()); off(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function mount() {
  await act(async () => root.render(<I18nProvider><ProviderModels profiles={[
    { profile_id: 'one', display_name: 'First', model: 'saved' }, { profile_id: 'two', display_name: 'Second', model: 'saved' },
  ]} configured={{ providerID: 'one', modelID: 'saved' }} onSaved={saved} /></I18nProvider>));
}
async function click(label: string) { await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); }
it('does not contact providers until discovery is requested, then shares their catalog with the composer', async () => {
  await mount(); expect(harnessClient.discoverProviderModels).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="provider-discover"]')!.click());
  expect(document.querySelector('[aria-label="Favorite extra from one"]')).not.toBeNull();
  expect(useModelCatalog.getState().models.one).toEqual(['saved', 'extra']);
});
it('changes only the named provider model preference and disables writes during revision conflicts', async () => {
  await mount(); await click('Favorite saved from two'); await click('Show saved from one in picker');
  expect(write.mock.calls).toEqual([['favoriteModels', ['two/saved']], ['hiddenModels', ['one/saved']]]);
  expect(harnessClient.discoverProviderModels).not.toHaveBeenCalled();
  act(() => useNativePreferenceState.setState({ status: 'conflict' }));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Favorite saved from one"]')!.disabled).toBe(true);
});
it('prefills a selected model without changing routing, preserves a failed save, and confirms an exact route', async () => {
  rememberCatalog('two', ['saved', 'other'], catalogOwner());
  const save = vi.spyOn(harnessClient, 'setPrimaryProviderRoute').mockResolvedValueOnce({ error: 'Provider unavailable' } as never)
    .mockResolvedValueOnce({ data: { configured_primary_route: { providerID: 'two', modelID: 'other' } } } as never);
  await mount(); await click('Choose primary other from two'); expect(save).not.toHaveBeenCalled();
  const group = document.querySelector('[aria-label="Models from Second"]')!;
  await act(async () => group.querySelector<HTMLButtonElement>('[data-testid="primary-save"]')!.click());
  expect(group.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
  expect(group.querySelector<HTMLInputElement>('[data-testid="primary-model"]')!.value).toBe('other');
  expect(saved).not.toHaveBeenCalled();
  await act(async () => group.querySelector<HTMLButtonElement>('[data-testid="primary-save"]')!.click());
  expect(save).toHaveBeenLastCalledWith('two', 'other'); expect(saved).toHaveBeenCalledOnce();
});
it('filters models without changing favorites or routing and reports an empty match', async () => {
  await mount(); const input = document.querySelector<HTMLInputElement>('[aria-label="Search configured models"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'absent'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(document.querySelector('[aria-label="Favorite saved from one"]')).toBeNull();
  expect(document.querySelectorAll('section[aria-label^="Models from "]')).toHaveLength(0);
  expect(document.body.textContent).toContain('No matching models'); expect(write).not.toHaveBeenCalled();
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Second'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(document.querySelectorAll('section[aria-label^="Models from "]')).toHaveLength(1);
  expect(document.querySelector('[aria-label="Models from Second"]')).not.toBeNull();
});
