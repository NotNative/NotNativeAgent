// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { SettingsWindow } from '../window.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { ThemeProvider } from '../../ThemeProvider.tsx';
import { connectNativePreferences, useNativePreferenceState } from '../../../lib/settings/native-preferences.ts';
import { NATIVE_PREFERENCE_DEFAULTS } from '../../../lib/settings/native-registry.ts';
import { useSettingsStore } from '../../../lib/settings/store.ts';
import { bindAppearanceAppliers } from '../../../lib/settings/apply.ts';
import { NATIVE_FOUNDATION_SEARCH } from '../pages/native-foundation.tsx';
import type { SettingsPageSlug } from '../search.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: Root, disconnect: () => void, offApply: () => void;
let settings: Record<string, unknown>, revision: number;
const fetchMock = vi.mocked(runtimeFetch);
beforeEach(async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  settings = { ...NATIVE_PREFERENCE_DEFAULTS }; revision = 0;
  fetchMock.mockReset(); fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === '/health') return new Response(JSON.stringify({ runtime: 'service', version: 'test' }));
    if (String(url).includes('/api/ui-preferences')) {
      if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); if (body.expected_revision !== revision) return new Response('{}', { status: 409 }); settings = { ...settings, ...body.settings }; revision += 1; }
      return new Response(JSON.stringify({ revision, settings }));
    }
    return new Response('{}', { status: 404 });
  });
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  await act(async () => { disconnect = connectNativePreferences(); offApply = bindAppearanceAppliers(); });
});
afterEach(() => { act(() => root.unmount()); disconnect(); offApply(); node.remove(); vi.unstubAllGlobals(); document.documentElement.style.fontSize = ''; });
async function render(page: SettingsPageSlug) { await act(async () => root.render(<I18nProvider><ThemeProvider><SettingsWindow nativeAlpha initialPage={page} onClose={() => undefined} /></ThemeProvider></I18nProvider>)); }
async function select(label: string, value: string) {
  const target = node.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  expect(target).not.toBeNull();
  await act(async () => { target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(done => setTimeout(done, 230)); });
}
it('maps native search to actual controls and lists only implemented keyboard commands', async () => {
  for (const field of NATIVE_FOUNDATION_SEARCH) { await render(field.page); expect(node.querySelector(`[data-settings-item="${field.id}"]`), field.id).not.toBeNull(); }
  expect([...node.querySelectorAll('[data-settings-item^="shortcuts.row."]')].map(el => el.getAttribute('data-settings-item'))).toEqual([
    'shortcuts.row.focus_input', 'shortcuts.row.new_chat', 'shortcuts.row.toggle_sidebar', 'shortcuts.row.open_settings', 'shortcuts.row.cycle_theme',
  ]);
});
it('applies theme and interface size to the document and saves them', async () => {
  await render('appearance'); await select('Theme', 'light');
  expect(settings.useSystemTheme).toBe(false); expect(settings.themeId).toBe(settings.lightThemeId);
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  await select('Interface size', '125'); expect(document.documentElement.style.fontSize).toBe('125%'); expect(settings.fontSize).toBe(125);
  await select('Theme', 'dark'); expect(document.documentElement.classList.contains('dark')).toBe(true);
});
it('saves conversation and notification choices without engine configuration writes', async () => {
  await render('chat'); await select('Send message with', 'modifier'); expect(settings).toMatchObject({ enterToSend: false, enterToSendConfigured: true });
  const checkbox = node.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { checkbox.click(); await new Promise(done => setTimeout(done, 230)); }); expect(settings.inputSpellcheckEnabled).toBe(false);
  await select('Your message format', 'plain'); await select('Send message with', 'default'); expect(settings.enterToSendConfigured).toBe(false);
  await render('notifications'); await select('Turn completion indicator', 'static'); expect(settings.celebrationPreference).toBe('static');
  expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'PUT' && String(url) !== '/api/ui-preferences')).toBe(false);
});
it('shows conflicts, preserves local edits, and reloads the saved choice explicitly', async () => {
  await render('chat'); fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }));
  await select('Your message format', 'plain'); expect(useNativePreferenceState.getState().status).toBe('conflict');
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('another window'); expect(node.querySelector('fieldset')?.disabled).toBe(true);
  expect(useSettingsStore.getState().doc.userMessageRenderingMode).toBe('plain');
  const reload = [...node.querySelectorAll('button')].find(button => button.textContent?.startsWith('Reload saved settings'))!;
  await act(async () => reload.click()); expect(useSettingsStore.getState().doc.userMessageRenderingMode).toBe('markdown'); expect(node.querySelector('fieldset')?.disabled).toBe(false);
});
