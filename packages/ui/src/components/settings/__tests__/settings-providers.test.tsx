// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Pins provider inventory safety, profile denial paths, and explicit diagnostics. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { harnessClient } from '../../../lib/nnd/client.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useI18nStore } from '../../../lib/i18n/store.ts';
import { ProvidersPage } from '../pages/providers.tsx';

// Provider assertions exercise the inventory/editor alerts. The independent
// native setup transport has its own cancellation and failure coverage.
vi.mock('../../../lib/nnd/setup.ts', () => ({ requestNativeSetup: async () => ({
  status: { service_state: 'ready', configuration_state: 'ready', execution_state: 'ready',
    provider_state: 'unknown', failure_code: null }, error: false,
}) }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE = { profile_id: 'profile', endpoint: 'https://provider.example.com/v1/path', model: 'configured', active: true };

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function settle(ms = 20): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

function mount(node: Parameters<Root['render']>[0]): void {
  if (rootHandle !== null) { const previous = rootHandle; act(() => { previous.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<I18nProvider>{node}</I18nProvider>); });
}

function click(testid: string, nth = 0): void {
  act(() => {
    document.querySelectorAll(`[data-testid="${testid}"]`)[nth]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function clickScoped(testid: string, scopeSelector: string): void {
  act(() => {
    document.querySelector(`${scopeSelector} [data-testid="${testid}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setValue(testid: string, value: string): Promise<void> {
  const node = document.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  return act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (rootHandle !== null) { const closing = rootHandle; act(() => { closing.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
  vi.restoreAllMocks();
  useI18nStore.getState().setLocale('en');
});

describe('NNA provider profiles and diagnostics', () => {
  it('renders a valid profile and refuses duplicate provider IDs', async () => {
    const inventory = vi.spyOn(harnessClient, 'listProviderProfiles')
      .mockResolvedValueOnce({ data: { profiles: [PROFILE], configured_primary_route: { providerID: 'profile', modelID: 'configured' } } } as never)
      .mockResolvedValueOnce({ data: { profiles: [{ ...PROFILE }, PROFILE] } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    expect(document.querySelectorAll('[data-testid="provider-profile"]').length).toBe(1);
    click('providers-refresh');
    await act(async () => { await settle(); });
    expect(document.querySelectorAll('[data-testid="provider-profile"]').length).toBe(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned an invalid provider inventory.');
    expect(inventory.mock.calls.length).toBe(2);
  });

  it('creates only after an exact profile echo and preserves the secret discipline', async () => {
    const saved = vi.fn();
    const inventory = vi.spyOn(harnessClient, 'listProviderProfiles').mockResolvedValue({ data: { profiles: [] } } as never);
    const create = vi.spyOn(harnessClient, 'createProviderProfile')
      .mockResolvedValueOnce({ data: { profile: { profile_id: 'new-profile', model: 'wrong' } } } as never)
      .mockResolvedValueOnce({ data: { profile: { endpoint: 'https://provider.example.org', model: 'new-model', profile_id: 'new-profile', display_name: 'New profile' } } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    click('providers-refresh');
    click('provider-profile-toggle');
    await act(async () => { await settle(); });
    await setValue('provider-profile-id', 'new-profile');
    await setValue('provider-profile-endpoint', 'https://provider.example.org');
    await setValue('provider-profile-model', 'new-model');
    await setValue('provider-profile-name', 'New profile');
    click('provider-profile-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm the profile change.');
    click('provider-profile-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(inventory.mock.calls.length).toBe(3);
    const requested = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(requested.profile_id).toBe('new-profile');
    expect(requested.endpoint).toBe('https://provider.example.org');
    expect(requested.model).toBe('new-model');
    // The name field was filled in and reaches the wire on the PATCH path, but
    // nothing on the create path asserted it, so providers[*].display_name had no
    // proof its create flow carried it at all.
    expect(requested.display_name).toBe('New profile');
    expect(Object.hasOwn(requested, 'credential_env')).toBe(false);
  });

  it('tests a model and accepts only a confirmed provider identity', async () => {
    vi.spyOn(harnessClient, 'listProviderProfiles').mockResolvedValue({ data: { profiles: [PROFILE] } } as never);
    const result = vi.spyOn(harnessClient, 'testProviderProfile')
      .mockResolvedValueOnce({ data: { profile_id: 'other', status: 'ready', selected_model: 'configured', discovered_models: 1 } } as never)
      .mockResolvedValueOnce({ data: { profile_id: 'profile', status: 'model_unavailable', selected_model: 'configured', discovered_models: 0 } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    click('provider-test');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned an invalid provider test result.');
    click('provider-test');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="status"]')?.textContent).toContain('not found');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(result.mock.calls.length).toBe(2);
  });

  it('discovers and shows only the first 50 models', async () => {
    vi.spyOn(harnessClient, 'listProviderProfiles').mockResolvedValue({ data: { profiles: [PROFILE] } } as never);
    vi.spyOn(harnessClient, 'discoverProviderModels').mockResolvedValue({ data: { profile_id: 'profile', models: ['m-0', 'm-0', ...Array.from({ length: 49 }, (_, index) => `m-${index + 1}`)] } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    click('provider-discover');
    await act(async () => { await settle(); });
    const result = document.querySelector('[data-testid="provider-models"]');
    expect(result?.querySelectorAll('li').length).toBe(50);
    expect(result?.textContent).toContain('51');
  });

  it('updates display names only after an exact optional-field echo', async () => {
    const namedProfile = { ...PROFILE, display_name: 'Old name' };
    const updatedProfile = { ...namedProfile, display_name: 'Updated' };
    vi.spyOn(harnessClient, 'listProviderProfiles')
      .mockResolvedValueOnce({ data: { profiles: [namedProfile] } } as never)
      .mockResolvedValue({ data: { profiles: [updatedProfile] } } as never);
    const update = vi.spyOn(harnessClient, 'updateProviderProfile')
      .mockResolvedValueOnce({ data: { profile: { ...updatedProfile, display_name: 'wrong' } } } as never)
      .mockResolvedValueOnce({ data: { profile: updatedProfile } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    clickScoped('provider-profile-toggle', '[data-testid="provider-profile"]');
    await act(async () => { await settle(); });
    await setValue('provider-profile-name', 'Updated');
    clickScoped('provider-profile-save', '[data-testid="provider-profile"]');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm the profile change.');
    expect(update.mock.calls[0]?.[1]).toEqual({ display_name: 'Updated', endpoint: 'https://provider.example.com/v1/path', model: 'configured' });
    clickScoped('provider-profile-save', '[data-testid="provider-profile"]');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('Updated');
  });

  it('rejects HTTP 200 inventories with empty or malformed operational fields', async () => {
    const inventory = vi.spyOn(harnessClient, 'listProviderProfiles')
      .mockResolvedValueOnce({ data: { profiles: [{ ...PROFILE, endpoint: '' }] } } as never)
      .mockResolvedValueOnce({ data: { profiles: [{ ...PROFILE, model: 'm'.repeat(4097) }] } } as never);
    mount(<ProvidersPage />);
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned an invalid provider inventory.');
    click('providers-refresh');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned an invalid provider inventory.');
    expect(inventory.mock.calls.length).toBe(2);
  });

  it('keeps fallback feedback in the active locale after a late HTTP response', async () => {
    let resolveInventory!: (result: unknown) => void;
    vi.spyOn(harnessClient, 'listProviderProfiles').mockImplementation(() => new Promise((resolvePromise) => {
      resolveInventory = resolvePromise as typeof resolveInventory;
    }));
    mount(<ProvidersPage />);
    await act(async () => {
      useI18nStore.getState().setLocale('de');
      await Promise.resolve();
    });
    await act(async () => {
      resolveInventory({ data: { profiles: [{ ...PROFILE, endpoint: '' }] } });
      await Promise.resolve();
    });
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA hat ein ungültiges Anbieterverzeichnis zurückgegeben.');
    await act(async () => { useI18nStore.getState().setLocale('en'); });
  });
});
