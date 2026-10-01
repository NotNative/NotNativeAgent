// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * SettingsWindow gates (doc 14 §G.1/§G.2/§G.6): centered dialog chrome,
 * grouped nav with built vs landing pages, the search index jump to
 * `data-settings-item` anchors, landing notes for phase pages, and the
 * refuse-to-close-while-recording rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { SettingsWindow } from '../window.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { ThemeProvider } from '../../ThemeProvider.tsx';
import { __resetEngineForTests } from '../../../lib/settings/persistence.ts';
import { __resetSettingsStoreForTests } from '../../../lib/settings/store.ts';
import { __resetShortcutRegistryForTests } from '../../../lib/shortcuts/registry.ts';
import { searchIndex, BUILT_PAGE_SLUGS, SETTINGS_PAGE_ORDER, type SettingsPageSlug } from '../search.ts';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ModeListener = (event: MediaQueryListEvent) => void;
let matchListeners: ModeListener[] = [];
vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
  matches: true,
  addEventListener: (_kind: string, listener: ModeListener) => { matchListeners.push(listener); },
  removeEventListener: (_kind: string, listener: ModeListener) => {
    matchListeners = matchListeners.filter((entry) => entry !== listener);
  },
})));

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

async function renderWindow(
  initialPage?: Parameters<typeof SettingsWindow>[0]['initialPage'],
  onClose?: () => void,
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <ThemeProvider>
          <SettingsWindow initialPage={initialPage} onClose={onClose ?? (() => undefined)} />
        </ThemeProvider>
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ surface: 'web', chatRenderMode: 'live', fontSize: 100 }));
  __resetEngineForTests();
  __resetSettingsStoreForTests();
  __resetShortcutRegistryForTests();
  useGlobalSyncStore.getState().reset();
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
});

describe('SettingsWindow (§G.1/§G.2/§G.6)', () => {
  it('mounts the dialog chrome with the grouped nav', async () => {
    await renderWindow('appearance');
    const win = document.querySelector('[data-testid="settings-window"]');
    expect(win).not.toBeNull();
    const navText = document.querySelector('nav')?.textContent ?? '';
    expect(navText).toContain('Appearance');
    expect(navText).toContain('Projects (Workspace)');
  });

  it('renders the built appearance page with settingsItem anchors', async () => {
    await renderWindow('appearance');
    expect(document.querySelector('[data-settings-item="appearance.interface-font-size"]')).not.toBeNull();
    expect(document.querySelector('[data-settings-item="appearance.light-theme"]')).not.toBeNull();
  });

  it('search jumps to the matching control on the owning page (§G.6)', async () => {
    await renderWindow('general');
    const search = document.querySelector('input[placeholder^="Search settings"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'font size');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const resultButtons = [...document.querySelectorAll('button')].filter((node) => node.textContent?.includes('Interface font size'));
    expect(resultButtons.length).toBeGreaterThan(0);
    await act(async () => {
      resultButtons[0]!.click();
      await new Promise((done) => setTimeout(done, 60)); // rAF frame + highlight schedule
      await Promise.resolve();
    });
    const anchor = document.querySelector('[data-settings-item="appearance.interface-font-size"]');
    expect(anchor).not.toBeNull(); // page switched to appearance
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(anchor?.getAttribute('data-settings-search-highlight')).toBe('true'); // 1600 ms highlight owns the TARGET
  });

  it('every search item resolves to a rendered settingsItem anchor (§G.6 gate)', async () => {
    for (const slug of BUILT_PAGE_SLUGS) {
      await renderWindow(slug);
      for (const item of searchIndex().filter((entry) => entry.page === slug)) {
        expect(
          document.querySelector(`[data-settings-item="${item.id}"]`),
          `${item.id} missing on ${slug}`,
        ).not.toBeNull();
      }
      act(() => rootHandle?.unmount());
      container?.remove();
    }
    container = null;
    rootHandle = null;
  });

  it('providers shows NNA inventory failure rather than an invented empty list', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'provider read denied' } }), { status: 403 })));
    await renderWindow('providers');
    expect(document.body.textContent).toContain('provider read denied');
    expect(document.body.textContent).not.toContain('No provider profiles');
  });

  it('providers shows only NNA public profile fields and marks the active route', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ profiles: [{
      profile_id: 'local', display_name: 'Local', endpoint: 'http://127.0.0.1:11434/v1?api_key=SECRET_QUERY', model: 'test-model',
      active: true, credential_env: 'SECRET_NAME',
    }], configured_primary_route: { providerID: 'local', modelID: 'test-model' } }), { status: 200 })));
    await renderWindow('providers');
    expect(document.querySelectorAll('[data-testid="provider-profile"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('test-model');
    expect(document.body.textContent).toContain('Configured primary');
    expect(document.body.textContent).toContain('http://127.0.0.1:11434');
    expect(document.body.textContent).not.toContain('SECRET_QUERY');
    expect(document.body.textContent).not.toContain('/v1?');
    expect(document.body.textContent).not.toContain('SECRET_NAME');
  });

  it('creates and edits NNA profiles on explicit clicks without sending credential values or deleting', async () => {
    const writes: Array<{ url: string; method: string; body: Record<string, string> }> = [];
    let profiles = [{ profile_id: 'local', display_name: 'Local', endpoint: 'http://127.0.0.1:11434/v1?token=SECRET', model: 'old', active: true }];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/provider-profiles') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ url, method: 'POST', body });
        profiles = [...profiles, { ...body, active: true }];
        return Promise.resolve(new Response(JSON.stringify({ profile: body }), { status: 201 }));
      }
      if (url.endsWith('/v1/provider-profiles/local') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        writes.push({ url, method: 'PATCH', body });
        profiles = profiles.map((profile) => profile.profile_id === 'local' ? { ...profile, ...body } : profile);
        return Promise.resolve(new Response(JSON.stringify({ profile: profiles[0] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ profiles }), { status: 200 }));
    });
    const enter = async (label: string, value: string): Promise<void> => {
      const input = [...document.querySelectorAll('label')].find((item) => item.textContent?.includes(label))?.querySelector('input');
      expect(input, label).toBeTruthy();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await renderWindow('providers');
    expect(document.body.textContent).not.toContain('SECRET');
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add provider profile')?.click(); });
    await enter('Profile ID', 'second');
    await enter('Endpoint URL', 'http://127.0.0.1:2244/v1');
    await enter('Default model', 'new-model');
    await enter('Credential environment variable', 'PROVIDER_KEY');
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Create profile')?.click(); await Promise.resolve(); });
    expect(writes[0]).toMatchObject({ method: 'POST', body: { profile_id: 'second', model: 'new-model', credential_env: 'PROVIDER_KEY' } });
    expect(document.querySelectorAll('[data-testid="provider-profile"]')).toHaveLength(2);
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add provider profile')?.click(); });
    const freshId = [...document.querySelectorAll('label')].find((item) => item.textContent?.includes('Profile ID'))?.querySelector('input');
    expect(freshId?.value).toBe('');
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel profile edit')?.click(); });
    const first = document.querySelector('[data-testid="provider-profile"]')!;
    await act(async () => { [...first.querySelectorAll('button')].find((button) => button.textContent === 'Edit profile')?.click(); });
    expect(first.textContent).not.toContain('SECRET');
    await enter('New endpoint (blank keeps current)', 'http://127.0.0.1:3322/v1');
    await act(async () => { [...first.querySelectorAll('button')].find((button) => button.textContent === 'Save profile changes')?.click(); await Promise.resolve(); });
    expect(writes[1]).toMatchObject({ method: 'PATCH', body: { endpoint: 'http://127.0.0.1:3322/v1', model: 'old' } });
    expect(writes.every((entry) => entry.method !== 'DELETE' && !JSON.stringify(entry).includes('SECRET'))).toBe(true);
  });

  it('provider diagnostics run only on click and keep discovery credentials in NNA', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/primary/test')) return Promise.resolve(new Response(JSON.stringify({
        profile_id: 'primary', status: 'ready', selected_model: 'test-model', discovered_models: 2,
      }), { status: 200 }));
      if (url.includes('/primary/discover')) return Promise.resolve(new Response(JSON.stringify({
        profile_id: 'primary', models: ['test-model', 'other-model'],
      }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ profiles: [{ profile_id: 'primary',
        endpoint: 'http://127.0.0.1:11434/v1', model: 'test-model', active: true }] }), { status: 200 }));
    });
    await renderWindow('providers');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/primary/test'))).toBe(false);
    const test = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test configured model');
    await act(async () => { test?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Configured model found in provider catalog');
    expect(document.body.textContent).toContain('This does not test inference.');
    const discover = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Discover models');
    await act(async () => { discover?.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="provider-models"]')?.textContent).toContain('other-model');
  });

  it('provider route drift distinguishes disk configuration from running NNA', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      profiles: [{ profile_id: 'new', endpoint: 'http://127.0.0.1:11434/v1', model: 'new-model', active: true },
        { profile_id: 'old', endpoint: 'http://127.0.0.1:2244/v1', model: 'old-model', active: true }],
      configured_primary_route: { providerID: 'new', modelID: 'new-model' },
      runtime_route: { providerID: 'old', modelID: 'old-model' },
    }), { status: 200 })));
    await renderWindow('providers');
    expect(document.body.textContent).toContain('Configuration differs from the running NNA route');
    expect(document.body.textContent).toContain('Apply saved provider routing to new sessions');
    expect(document.querySelectorAll('[data-testid="provider-profile"]')[0]?.textContent).toContain('Configured primary');
    expect(document.querySelectorAll('[data-testid="provider-profile"]')[1]?.textContent).toContain('Running NNA route');
  });

  it('compares primary route overrides rather than a provider profile default model', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      profiles: [{ profile_id: 'primary', endpoint: 'http://127.0.0.1:11434/v1', model: 'default-model', active: true }],
      configured_primary_route: { providerID: 'primary', modelID: 'selected-model' },
      runtime_route: { providerID: 'primary', modelID: 'selected-model' },
    }), { status: 200 })));
    await renderWindow('providers');
    expect(document.body.textContent).not.toContain('Configuration differs from the running NNA route');
    expect(document.body.textContent).toContain('Configured primary model: selected-model');
    expect(document.body.textContent).toContain('Running NNA model: selected-model');
    expect(document.querySelector('[data-testid="provider-profile"]')?.textContent).toContain('Running NNA route');
  });

  it('changes only the saved primary route on explicit click and reports NNA denial', async () => {
    let selected = 'old';
    let denied = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/provider-route')) {
        if (denied) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'route denied' } }), { status: 403 }));
        expect(init?.method).toBe('PATCH');
        expect(JSON.parse(String(init?.body))).toEqual({ provider_id: 'new', model: 'new-model' });
        selected = 'new';
        return Promise.resolve(new Response(JSON.stringify({ configured_primary_route: { providerID: 'new', modelID: 'new-model' }, runtime_route: { providerID: 'old', modelID: 'old-model' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        profiles: [{ profile_id: 'old', endpoint: 'http://127.0.0.1:11434/v1', model: 'old-model', active: true },
          { profile_id: 'new', endpoint: 'http://127.0.0.1:2244/v1', model: 'new-model', active: true }],
        configured_primary_route: { providerID: selected, modelID: `${selected}-model` },
        runtime_route: { providerID: 'old', modelID: 'old-model' },
      }), { status: 200 }));
    });
    await renderWindow('providers');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/provider-route'))).toBe(false);
    const newProfile = document.querySelectorAll('[data-testid="provider-profile"]')[1]!;
    const action = [...newProfile.querySelectorAll('button')].find((button) => button.textContent === 'Save primary route');
    await act(async () => { action?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Configuration differs from the running NNA route');
    expect(document.body.textContent).toContain('Configured primary');
    denied = true;
    const otherAction = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save primary route' && !button.hasAttribute('disabled'));
    await act(async () => { otherAction?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('route denied');
    expect(selected).toBe('new');
  });

  it('preserves and can change a configured model override without switching profiles', async () => {
    let model = 'custom-model';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/provider-route')) {
        expect(JSON.parse(String(init?.body))).toEqual({ provider_id: 'primary', model: 'another-model' });
        model = 'another-model';
        return Promise.resolve(new Response(JSON.stringify({ configured_primary_route: { providerID: 'primary', modelID: model } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        profiles: [{ profile_id: 'primary', endpoint: 'http://127.0.0.1:11434/v1', model: 'default-model', active: true }],
        configured_primary_route: { providerID: 'primary', modelID: model },
        runtime_route: { providerID: 'primary', modelID: 'custom-model' },
      }), { status: 200 }));
    });
    await renderWindow('providers');
    const input = document.querySelector('[data-testid="provider-profile"] input') as HTMLInputElement;
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save primary route')!;
    expect(input.value).toBe('custom-model');
    expect(save.hasAttribute('disabled')).toBe(true);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'another-model'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(save.hasAttribute('disabled')).toBe(false);
    await act(async () => { save.click(); await Promise.resolve(); });
    expect(model).toBe('another-model');
    expect(document.body.textContent).toContain('Configured primary model: another-model');
    expect(document.body.textContent).toContain('Configuration differs from the running NNA route');
  });

  it('applies a saved route to new sessions only after an explicit action', async () => {
    useGlobalSyncStore.getState().set({ config: { nnd: { engine: 'nna',
      primaryModel: { providerID: 'old', modelID: 'old-model' } } } });
    let running = 'old';
    let denied = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/provider-route/activate')) {
        expect(init?.method).toBe('POST');
        if (denied) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'activation denied' } }), { status: 403 }));
        running = 'new';
        return Promise.resolve(new Response(JSON.stringify({ runtime_route: { providerID: 'new', modelID: 'new-model' }, existing_sessions_unchanged: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        profiles: [{ profile_id: 'new', endpoint: 'http://127.0.0.1:11434/v1', model: 'new-model', active: true }],
        configured_primary_route: { providerID: 'new', modelID: 'new-model' },
        runtime_route: { providerID: running, modelID: `${running}-model` },
      }), { status: 200 }));
    });
    await renderWindow('providers');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/provider-route/activate'))).toBe(false);
    expect(document.body.textContent).toContain('Existing sessions retain their own routing');
    const activate = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply saved provider routing to new sessions');
    await act(async () => { activate?.click(); await Promise.resolve(); });
    expect(running).toBe('new');
    expect((useGlobalSyncStore.getState().config?.nnd as { primaryModel?: unknown }).primaryModel)
      .toEqual({ providerID: 'new', modelID: 'new-model' });
    expect(document.body.textContent).not.toContain('Configuration differs from the running NNA route');
    running = 'old'; denied = true;
    const refresh = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Refresh');
    await act(async () => { refresh?.click(); await Promise.resolve(); });
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply saved provider routing to new sessions');
    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('activation denied');
    expect(running).toBe('old');
    expect((useGlobalSyncStore.getState().config?.nnd as { primaryModel?: unknown }).primaryModel)
      .toEqual({ providerID: 'new', modelID: 'new-model' });
  });

  it('offers activation for changed provider profiles even when the primary route matches', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith('/v1/provider-profiles') ? {
        profiles: [{ profile_id: 'primary', endpoint: 'http://127.0.0.1:11434/v1', model: 'test', active: true }],
        configured_primary_route: { providerID: 'primary', modelID: 'test' },
        runtime_route: { providerID: 'primary', modelID: 'test' },
        provider_routing_pending: true,
      } : { surface: 'web', chatRenderMode: 'live', fontSize: 100 },
    ), { status: 200 })));
    await renderWindow('providers');
    expect(document.body.textContent).toContain('Saved provider routing or profiles differ');
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Apply saved provider routing to new sessions')).toBe(true);
  });

  it('provider diagnostic failure is not reported as a successful model check', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(
      url.includes('/primary/test')
        ? JSON.stringify({ error: { message: 'provider catalog unreachable' } })
        : JSON.stringify({ profiles: [{ profile_id: 'primary', endpoint: 'http://127.0.0.1:11434/v1',
          model: 'test-model', active: true }] }),
      { status: url.includes('/primary/test') ? 502 : 200 },
    )));
    await renderWindow('providers');
    const test = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test configured model');
    await act(async () => { test?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('provider catalog unreachable');
    expect(document.body.textContent).not.toContain('Configured model found in provider catalog');
  });

  it('refresh clears a diagnostic even if the provider keeps the same id and model', async () => {
    let endpoint = 'http://127.0.0.1:11434/v1';
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.includes('/primary/test')
        ? { profile_id: 'primary', status: 'ready', selected_model: 'test-model', discovered_models: 1 }
        : { profiles: [{ profile_id: 'primary', endpoint, model: 'test-model', active: true }] },
    ), { status: 200 })));
    await renderWindow('providers');
    const test = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test configured model');
    await act(async () => { test?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Configured model found in provider catalog');
    endpoint = 'http://127.0.0.1:2244/v1';
    const refresh = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Refresh');
    await act(async () => { refresh?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('http://127.0.0.1:2244');
    expect(document.body.textContent).not.toContain('Configured model found in provider catalog');
  });

  it('MCP distinguishes configuration from connection health and hides destinations', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      version: 1, state: 'configured', servers: [{ id: 'memory', transport: 'streamable_http', enabled: true,
        trusted: false, endpoint: 'https://mcp.example/private?api_key=SECRET_QUERY', command: 'secret-command' }],
    }), { status: 200 })));
    await renderWindow('mcp');
    expect(document.querySelectorAll('[data-testid="mcp-server"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Connection unverified');
    expect(document.body.textContent).toContain('Enabled');
    expect(document.body.textContent).not.toContain('mcp.example');
    expect(document.body.textContent).not.toContain('SECRET_QUERY');
    expect(document.body.textContent).not.toContain('secret-command');
  });

  it('MCP denial is not shown as an empty inventory', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'MCP read denied' } }), { status: 403 })));
    await renderWindow('mcp');
    expect(document.body.textContent).toContain('MCP read denied');
    expect(document.body.textContent).not.toContain('No MCP servers');
  });

  it('skills lists NNA-discovered metadata without instruction bodies or paths', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      version: 1, state: 'discovered', skills: [{ id: 'review', version: '1',
        description: 'Review code', invocation: 'both', body: 'SECRET_INSTRUCTION', source: 'C:/secret/SKILL.md' }],
    }), { status: 200 })));
    await renderWindow('skills.installed');
    expect(document.querySelectorAll('[data-testid="nna-skill"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Review code');
    expect(document.body.textContent).toContain('User + agent');
    expect(document.body.textContent).not.toContain('SECRET_INSTRUCTION');
    expect(document.body.textContent).not.toContain('C:/secret');
  });

  it('skills denial is not presented as no installed skills', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'skill read denied' } }), { status: 403 })));
    await renderWindow('skills.installed');
    expect(document.body.textContent).toContain('skill read denied');
    expect(document.body.textContent).not.toContain('No skills are available');
  });

  it('refreshes the skills catalog for newly created sessions', async () => {
    let version = '1';
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      version: 1, state: 'discovered', skills: [{ id: 'review', version,
        description: 'Review code', invocation: 'both' }],
    }), { status: 200 })));
    await renderWindow('skills.installed');
    expect(document.body.textContent).toContain('v1');
    expect(document.body.textContent).toContain('Existing sessions may use an earlier catalog');
    version = '2';
    const refresh = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Refresh');
    await act(async () => { refresh?.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('v2');
  });

  it('agents shows NNA built-in roles without treating configuration as a grant', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      version: 1, state: 'configured', route: { providerID: 'delegated', modelID: 'model-a' },
      roles: [{ id: 'general', kind: 'built_in_subagent', instructions: 'PRIVATE' },
        { id: 'reviewer', kind: 'built_in_subagent' }],
    }), { status: 200 })));
    await renderWindow('agents');
    expect(document.querySelectorAll('[data-testid="nna-agent-role"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('delegated/model-a');
    expect(document.body.textContent).toContain('does not grant delegation');
    expect(document.body.textContent).not.toContain('PRIVATE');
  });

  it('agents denial is not presented as an empty catalog', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'agent read denied' } }), { status: 403 })));
    await renderWindow('agents');
    expect(document.body.textContent).toContain('agent read denied');
    expect(document.body.textContent).not.toContain('no built-in subagent roles');
  });

  it('saves a subagent route separately from running delegation and applies it only on command', async () => {
    let configured = 'delegated';
    let running = 'delegated';
    const writes: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/provider-route/subagent')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          writes.push('save'); configured = body.provider_id;
          return Promise.resolve(new Response(JSON.stringify({ configured_route: { providerID: configured, modelID: body.model },
            runtime_route: { providerID: running, modelID: 'test' } }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ configured_route: { providerID: configured, modelID: 'test' },
          runtime_route: { providerID: running, modelID: 'test' } }), { status: 200 }));
      }
      if (url.endsWith('/v1/provider-route/activate')) {
        writes.push('apply'); running = configured;
        return Promise.resolve(new Response(JSON.stringify({ runtime_route: { providerID: 'primary', modelID: 'test' },
          existing_sessions_unchanged: true }), { status: 200 }));
      }
      if (url.endsWith('/v1/provider-profiles')) return Promise.resolve(new Response(JSON.stringify({
        profiles: [{ profile_id: 'delegated', model: 'test' }, { profile_id: 'primary', model: 'test' }],
        provider_routing_pending: configured !== running,
      }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ version: 1, state: 'configured',
        route: { providerID: running, modelID: 'test' }, roles: [{ id: 'general', kind: 'built_in_subagent' }],
      }), { status: 200 }));
    });
    await renderWindow('agents');
    expect(writes).toEqual([]);
    const selector = [...document.querySelectorAll('label')].find((item) => item.textContent?.includes('Provider profile'))?.querySelector('select');
    await act(async () => { selector!.value = 'primary'; selector!.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save subagent route')?.click(); await Promise.resolve(); });
    expect(writes).toEqual(['save']);
    expect(document.body.textContent).toContain('Saved: primary/test');
    expect(document.body.textContent).toContain('Running: delegated/test');
    expect(document.body.textContent).toContain('does not grant any agent permission');
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply saved provider routing to new sessions')?.click(); await Promise.resolve(); });
    expect(writes).toEqual(['save', 'apply']);
    expect(document.body.textContent).toContain('Running: primary/test');
  });

  it('landing pages render the phase note, never a silent gap', async () => {
    await renderWindow('plugins');
    expect(document.body.textContent).toContain('Plugins');
    expect(document.body.textContent).toContain('registered in the settings tree');
  });

  it('refuses to close while a recording dialog is open (§G.1)', async () => {
    const onClose = vi.fn();
    await renderWindow('shortcuts', onClose);
    const closeButtons = [...document.querySelectorAll('button')].filter((node) => (node.textContent ?? '').trim() === '✕');
    expect(closeButtons.length).toBeGreaterThan(0);
    const overlay = document.createElement('div');
    overlay.setAttribute('data-nnd-recording-overlay', '');
    document.body.appendChild(overlay);
    await act(async () => {
      closeButtons[0]!.click();
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled(); // §G.1 refusal while recording
    overlay.remove();
    await act(async () => {
      closeButtons[0]!.click();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
