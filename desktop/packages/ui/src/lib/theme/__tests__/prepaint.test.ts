// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CSSVariableGenerator, THEME_STYLE_ELEMENT_ID } from '../css-generator.ts';
import { prepaintTheme } from '../prepaint.ts';
import { DEFAULT_THEME_PREFERENCES, scopedThemeStorageKey, writeThemePreferences } from '../storage.ts';
import { getDefaultBuiltInTheme, getBuiltInTheme } from '../themes.ts';
import { initializeRuntimeEndpoint } from '../../runtime-switch.ts';

beforeEach(() => {
  localStorage.clear();
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
  document.head.innerHTML = '';
  CSSVariableGenerator.unapply();
  document.body.style.backgroundColor = '';
});

afterEach(() => {
  CSSVariableGenerator.unapply();
});

/** jsdom normalizes hex colors to rgb() — compare in that space. */
function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const channels = value.length === 3
    ? value.split('').map((c) => c + c)
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)];
  const [r, g, b] = channels.map((pair) => parseInt(pair, 16));
  return `rgb(${r}, ${g}, ${b})`;
}

function stored(prefs: Record<string, unknown>): void {
  localStorage.setItem(scopedThemeStorageKey('local'), JSON.stringify(prefs));
}

it('with no stored preferences, prepaint applies the default theme for the system variant', () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('dark') })) as never;
  prepaintTheme();
  const defaultDark = getDefaultBuiltInTheme(true)!;
  expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBeTruthy();
  expect(document.documentElement.dataset['theme']).toBe('dark');
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.body.style.backgroundColor).toBe(rgb(defaultDark.colors.surface.background));
});

it('prepaint honors the persisted light/dark pair and the explicit mode', () => {
  const light = getBuiltInTheme('solarized-light') ?? getDefaultBuiltInTheme(false)!;
  stored({ themeMode: 'light', lightThemeId: light.metadata.id, darkThemeId: DEFAULT_THEME_PREFERENCES.darkThemeId });
  window.matchMedia = (() => ({ matches: true })) as never; // system says dark, but mode is explicit
  prepaintTheme();
  expect(document.documentElement.dataset['theme']).toBe('light');
  expect(document.body.style.backgroundColor).toBe(rgb(light.colors.surface.background));

  stored({ themeMode: 'dark', lightThemeId: light.metadata.id, darkThemeId: 'notnative-dark' });
  prepaintTheme();
  expect(document.documentElement.dataset['theme']).toBe('dark');
  expect(document.body.style.backgroundColor).toBe(rgb((getBuiltInTheme('notnative-dark') ?? getDefaultBuiltInTheme(true)!).colors.surface.background));
});

it('an unknown stored id (custom theme not yet loaded) falls back to the default built-in', () => {
  stored({ themeMode: 'light', lightThemeId: 'my-custom-theme', darkThemeId: 'notnative-dark' });
  prepaintTheme();
  const fallback = getDefaultBuiltInTheme(false)!;
  expect(document.documentElement.dataset['theme']).toBe('light');
  expect(document.body.style.backgroundColor).toBe(rgb(fallback.colors.surface.background));
});

it('prepaint is idempotent with the ThemeProvider path: re-apply keeps one style element', () => {
  writeThemePreferences(DEFAULT_THEME_PREFERENCES);
  prepaintTheme();
  const first = document.getElementById(THEME_STYLE_ELEMENT_ID)!;
  const theme = getBuiltInTheme('notnative-light') ?? getDefaultBuiltInTheme(false)!;
  CSSVariableGenerator.apply(theme); // what the provider effect does post-mount
  expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBe(first);
});
