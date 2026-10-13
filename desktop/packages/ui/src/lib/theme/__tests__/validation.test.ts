// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * isValidTheme gate + custom-theme sanitization (doc 14 §E.6): the exact
 * required subset passes; truncated/mistyped themes are rejected; the server
 * body filter keeps only valid shapes.
 */
import { describe, expect, it } from 'vitest';
import { getBuiltInTheme } from '../themes.ts';
import { isValidTheme, isThemeVariant, firstInvalidField } from '../validation.ts';
import { sanitizeCustomThemes } from '../custom.ts';
import type { Theme } from '../types.ts';

const dracula = getBuiltInTheme('dracula') as Theme;

function cloneTheme(): Theme {
  return JSON.parse(JSON.stringify(dracula)) as Theme;
}

function asRecord(parent: object): Record<string, unknown> {
  return parent as unknown as Record<string, unknown>;
}

describe('isValidTheme (doc 14 §E.6 gate)', () => {
  it('accepts a full clean build-in theme', () => {
    expect(isValidTheme(dracula)).toBe(true);
  });

  it('rejects non-objects, arrays and null', () => {
    expect(isValidTheme(null)).toBe(false);
    expect(isValidTheme([dracula])).toBe(false);
    expect(isValidTheme('dracula')).toBe(false);
  });

  it('rejects empty/id-less metadata and foreign variants', () => {
    const bad = cloneTheme();
    bad.metadata.id = '';
    expect(isValidTheme(bad)).toBe(false);
    const variant = cloneTheme();
    (variant.metadata.variant as unknown as string) = 'sepia';
    expect(isValidTheme(variant)).toBe(false);
  });

  it('rejects missing required colors at the documented seam', () => {
    const noPrimary = cloneTheme();
    delete asRecord(noPrimary.colors.primary).base;
    expect(isValidTheme(noPrimary)).toBe(false);
    const noSurface = cloneTheme();
    delete asRecord(noSurface.colors.surface).mutedForeground;
    expect(isValidTheme(noSurface)).toBe(false);
    const noStatus = cloneTheme();
    delete asRecord(noStatus.colors.status).warning;
    expect(isValidTheme(noStatus)).toBe(false);
    const noSyntax = cloneTheme();
    delete asRecord(noSyntax.colors.syntax).base;
    expect(isValidTheme(noSyntax)).toBe(false);
  });

  it('rejects non-hex color values and keeps variant narrowing', () => {
    const badHex = cloneTheme();
    badHex.colors.surface.background = 'tokyoplum';
    expect(isValidTheme(badHex)).toBe(false);
    expect(isThemeVariant('dark')).toBe(true);
    expect(isThemeVariant('light')).toBe(true);
    expect(isThemeVariant('system')).toBe(false);
  });

  it('firstInvalidField names the break on broken input', () => {
    const broken = cloneTheme();
    broken.metadata.name = '';
    expect(firstInvalidField(broken)).toBe('metadata.name');
    expect(firstInvalidField(dracula)).toBeNull();
  });
});

describe('sanitizeCustomThemes (§E.6 client re-check)', () => {
  it('keeps valid entries and silently skips invalid ones', () => {
    const broken = cloneTheme();
    delete asRecord(broken.metadata).id;
    const kept = sanitizeCustomThemes({ themes: [dracula, broken, null, 'thing'] });
    expect(kept.length).toBe(1);
    expect(kept[0]?.metadata.id).toBe('dracula');
  });

  it('tolerates malformed bodies', () => {
    expect(sanitizeCustomThemes(null)).toEqual([]);
    expect(sanitizeCustomThemes({})).toEqual([]);
    expect(sanitizeCustomThemes({ themes: 'no' })).toEqual([]);
  });
});
