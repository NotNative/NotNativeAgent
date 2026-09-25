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
    }] }), { status: 200 })));
    await renderWindow('providers');
    expect(document.querySelectorAll('[data-testid="provider-profile"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('test-model');
    expect(document.body.textContent).toContain('Active');
    expect(document.body.textContent).toContain('http://127.0.0.1:11434');
    expect(document.body.textContent).not.toContain('SECRET_QUERY');
    expect(document.body.textContent).not.toContain('/v1?');
    expect(document.body.textContent).not.toContain('SECRET_NAME');
  });

  it('landing pages render the phase note, never a silent gap', async () => {
    await renderWindow('agents');
    expect(document.body.textContent).toContain('Agents');
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
