// SPDX-License-Identifier: Apache-2.0
/**
 * Preset catalog gates (doc 14 §E.2/§E.6 + NOTES/14 C.1): 38 built-ins in
 * registration order, brand + flexoki alias resolution, pair/single variant
 * split, every theme VALID (isValidTheme) and PR-color-filled.
 */
import { describe, expect, it } from 'vitest';
import { withAlpha, darken, lighten } from '../color.ts';
import { buildTheme } from '../derive.ts';
import { withPrColors } from '../pr-colors.ts';
import type { Theme } from '../types.ts';
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getBuiltInTheme,
  getDefaultBuiltInTheme,
  listBuiltInThemes,
} from '../themes.ts';
import { isValidTheme, firstInvalidField } from '../validation.ts';

describe('built-in catalog (doc 14 §E.2)', () => {
  it('registers exactly 38 built-in themes', () => {
    expect(BUILT_IN_THEMES.length).toBe(38);
    expect(new Set(BUILT_IN_THEME_IDS).size).toBe(38);
  });

  it('opens with the brand pair and flexoki, closes with vitesse', () => {
    expect(BUILT_IN_THEME_IDS.slice(0, 4)).toEqual([
      'notnative-light',
      'notnative-dark',
      'flexoki-light',
      'flexoki-dark',
    ]);
    expect(BUILT_IN_THEME_IDS.slice(-2)).toEqual(['vitesse-dark', 'vitesse-light']);
  });

  it('keeps the documented family registration order', () => {
    const order = BUILT_IN_THEME_IDS.join(',');
    expect(order.indexOf('fields-of-the-shire-light')).toBeLessThan(order.indexOf('aura-light'));
    expect(order.indexOf('aura-light')).toBeLessThan(order.indexOf('ayu-light'));
    expect(order.indexOf('tokyonight-dark')).toBeLessThan(order.indexOf('dracula'));
    expect(order.indexOf('dracula')).toBeLessThan(order.indexOf(',mono-plus,'));
    expect(order.indexOf(',mono-plus,')).toBeLessThan(order.indexOf(',mono,'));
  });

  it('resolves 14 pair families plus 6 singles per NOTES/14 C.1', () => {
    const ids = new Set(BUILT_IN_THEME_IDS);
    for (const base of ['aura', 'ayu', 'carbonfox', 'catppuccin', 'gruvbox', 'jetbrains', 'kanagawa', 'monokai', 'nightowl', 'nord', 'onedarkpro', 'solarized', 'tokyonight', 'fields-of-the-shire']) {
      expect(ids.has(`${base}-light`), `${base}-light registered`).toBe(true);
      expect(ids.has(`${base}-dark`), `${base}-dark registered`).toBe(true);
    }
    expect(ids.has('dracula')).toBe(true);
    expect(ids.has('vesper')).toBe(true);
    expect(ids.has('mono-plus')).toBe(true);
    expect(ids.has('mono')).toBe(true);
  });

  it('aliases the legacy app-light/app-dark ids onto flexoki', () => {
    expect(getBuiltInTheme('app-light')?.metadata.id).toBe('flexoki-light');
    expect(getBuiltInTheme('app-dark')?.metadata.id).toBe('flexoki-dark');
  });

  it('getDefaultBuiltInTheme returns the brand default per variant', () => {
    expect(getDefaultBuiltInTheme(false).metadata.id).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(getDefaultBuiltInTheme(true).metadata.id).toBe(DEFAULT_DARK_THEME_ID);
    expect(listBuiltInThemes('dark').every((t) => t.metadata.variant === 'dark')).toBe(true);
  });
});

describe('built-in conformance (doc 14 §E.6)', () => {
  it('every built-in passes isValidTheme and reports no invalid field', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(isValidTheme(theme), `${theme.metadata.id} must validate`).toBe(true);
      expect(firstInvalidField(theme)).toBeNull();
    }
  });

  it('fills pr colors and keeps the 8-digit `90` surface alpha rule', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.colors.pr?.open).toBe(theme.colors.status.success.value);
      for (const key of ['muted', 'elevated'] as const) {
        expect(theme.colors.surface[key].endsWith('90'), `${theme.metadata.id} ${key}`).toBe(true);
      }
    }
  });

  it('derives the documented primary chain with EXACT values', () => {
    const theme = getBuiltInTheme('dracula')!;
    // §A.2 defaults: hover=darken10, active=darken20, muted 50% alpha, emphasis lighten10
    expect(theme.colors.primary.hover).toBe(darken(theme.colors.primary.base, 0.1));
    expect(theme.colors.primary.active).toBe(darken(theme.colors.primary.base, 0.2));
    expect(theme.colors.primary.emphasis).toBe(lighten(theme.colors.primary.base, 0.1));
    expect(theme.colors.primary.muted).toBe(withAlpha(theme.colors.primary.base, 0.5));
  });

  it('falls back pr.merged through className/token/keyword/platform chain', () => {
    const dracula = getBuiltInTheme('dracula')!;
    expect(dracula.colors.pr?.merged).toBe(dracula.colors.syntax.base.keyword); // token bag empty
    const withToken = JSON.parse(JSON.stringify(dracula)) as Theme;
    withToken.colors.syntax.tokens = { className: '#a1b2c3' };
    (withToken.colors as unknown as Record<string, unknown>).pr = undefined; // re-derive from scratch
    expect(withPrColors(withToken).colors.pr?.merged).toBe('#a1b2c3');
  });

  it('keeps seed syntax tokens inside the generated theme', () => {
    const theme = buildTheme({
      id: 'x', name: 'x', variant: 'dark', background: '#000000', foreground: '#ffffff', primary: '#3366cc',
      syntax: { tokens: { className: '#abcdef', stringRegex: '#fedcba' } },
    });
    expect(theme.colors.syntax.tokens?.className).toBe('#abcdef');
    expect(getBuiltInTheme('solarized-dark')!.colors.syntax.tokens).toBeUndefined();
  });

  it('exposes optional clusters on every preset (chat/tools/markdown)', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.colors.chat?.background).toBeTruthy();
      expect(theme.colors.tools?.edit.lineNumber).toBeTruthy();
      expect(theme.colors.markdown?.link).toBeTruthy();
      expect(theme.colors.charts?.series.length).toBe(5);
      expect(Object.keys(theme.colors.syntax.highlights).length).toBeGreaterThanOrEqual(8);
    }
  });
});
