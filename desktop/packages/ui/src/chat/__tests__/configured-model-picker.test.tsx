// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { harnessClient } from '../../lib/nnd/client.ts';
import { ConfiguredModelPicker } from '../configured-model-picker.tsx';
vi.mock('../../lib/nnd/client.ts', () => ({ harnessClient: { listProviderProfiles: vi.fn(), discoverProviderModels: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks(); document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector('#root')!);
  vi.mocked(harnessClient.listProviderProfiles).mockResolvedValue({ data: { profiles: [
    { profile_id: 'one', display_name: 'First', model: 'saved' }, { profile_id: 'two', display_name: 'Second', model: 'saved' },
  ] } } as never);
  vi.mocked(harnessClient.discoverProviderModels).mockImplementation(async id => id === 'one' ? { data: { models: ['discovered'] } } as never : { error: 'offline' } as never);
});
afterEach(() => { act(() => root.unmount()); });
async function mount(disabled = false) {
  const pick = vi.fn();
  await act(async () => root.render(<ConfiguredModelPicker selected={{ providerID: 'one', modelID: 'saved' }} disabled={disabled} onPick={pick} />));
  return pick;
}
async function open() { await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click(); }); }
it('groups configured models by provider and keeps saved models when discovery fails', async () => {
  const pick = await mount(); await open();
  expect(document.body.textContent).toContain('Saved models are still available');
  expect(document.querySelector('[aria-label="Use discovered from First"]')).not.toBeNull();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Use saved from Second"]')!.click());
  expect(pick).toHaveBeenCalledWith({ providerID: 'two', modelID: 'saved' });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Choose model');
});
it('searches models and closes with Escape without changing the choice', async () => {
  const pick = await mount(); await open();
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'discovered');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.querySelector('[aria-label="Use saved from Second"]')).toBeNull();
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(pick).not.toHaveBeenCalled();
});
it('shows a retry on profile failure and disables selection during a pending start', async () => {
  vi.mocked(harnessClient.listProviderProfiles).mockRejectedValue(new Error('offline'));
  await mount(); await open();
  expect(document.body.textContent).toContain('Configured providers are unavailable');
  vi.mocked(harnessClient.listProviderProfiles).mockResolvedValue({ data: { profiles: [] } } as never);
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(document.body.textContent).toContain('No configured providers');
  await mount(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.disabled).toBe(true);
});
