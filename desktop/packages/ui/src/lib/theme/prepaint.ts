// SPDX-License-Identifier: Apache-2.0
/**
 * Theme prepaint (W-02.theme-prepaint, doc 14 §E.4): applies the persisted
 * theme SYNCHRONOUSLY before React mounts, so the first paint already wears
 * the operator's theme instead of flashing the default. Reads the same
 * runtimeKey-scoped localStorage the ThemeProvider persists; resolves only
 * built-in themes (custom themes load asynchronously later, so an unknown id
 * falls back to the default built-in of the resolved variant — identical to
 * the ThemeProvider's pre-load fallback). Idempotent: the ThemeProvider's
 * post-mount effect re-applies through the same `CSSVariableGenerator`.
 */
import { CSSVariableGenerator } from './css-generator.ts';
import { DEFAULT_THEME_PREFERENCES, readThemePreferences } from './storage.ts';
import { getBuiltInTheme, getDefaultBuiltInTheme } from './themes.ts';

export function prepaintTheme(): void {
  if (typeof document === 'undefined') return;
  const prefs = readThemePreferences() ?? DEFAULT_THEME_PREFERENCES;
  const dark = prefs.themeMode === 'dark'
    || (prefs.themeMode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
  const theme = getBuiltInTheme(dark ? prefs.darkThemeId : prefs.lightThemeId)
    ?? getDefaultBuiltInTheme(dark);
  CSSVariableGenerator.apply(theme);
  document.body.style.backgroundColor = theme.colors.surface.background;
}
