// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Theme persistence (doc 14 §E.3): runtimeKey scoping (transient keys never
 * read/write), payload validation, legacy global seed path, splash mirror,
 * same-key storage-event adoption.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemePreferences } from '../storage.ts';

async function freshModule() {
  vi.resetModules();
  return {
    storage: await import('../storage.ts'),
    runtimeSwitch: await import('../../runtime-switch.ts'),
  };
}

const SCOPED = 'notnative.theme.v2:url%3Ahttp%3A%2F%2Fa.test';

describe('theme storage (doc 14 §E.3)', () => {
  let mod: Awaited<ReturnType<typeof freshModule>> | null = null;

  beforeEach(async () => {
    window.localStorage.clear();
    mod = await freshModule();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never reads or writes under the transient default runtime key', async () => {
    const { storage } = mod!;
    expect(storage.readThemePreferences()).toBeNull();
    storage.writeThemePreferences({ themeMode: 'dark', lightThemeId: 'dracula', darkThemeId: 'vesper' });
    expect(window.localStorage.getItem(SCOPED)).toBeNull();
    expect(window.localStorage.getItem('notnative.theme.v2:url%3Adefault')).toBeNull();
  });

  it('round-trips the scoped payload once a runtime key is bound', async () => {
    mod = await freshModule();
    mod.runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: 'http://a.test' });
    const { storage } = mod!;
    expect(storage.readThemePreferences()).toBeNull();
    storage.writeThemePreferences({ themeMode: 'dark', lightThemeId: 'vesper', darkThemeId: 'dracula' });
    expect(storage.readThemePreferences()).toEqual({
      themeMode: 'dark',
      lightThemeId: 'vesper',
      darkThemeId: 'dracula',
    });
  });

  it('treats malformed scoped payloads as absent (all-or-null)', async () => {
    mod = await freshModule();
    mod.runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: 'http://a.test' });
    const { storage } = mod!;
    window.localStorage.setItem(SCOPED, '{not json');
    expect(storage.readThemePreferences()).toBeNull();
    window.localStorage.setItem(SCOPED, JSON.stringify({ themeMode: 'sepia' }));
    expect(storage.readThemePreferences()).toBeNull();
    window.localStorage.setItem(SCOPED, JSON.stringify({ themeMode: 'light', darkThemeId: 9 }));
    expect(storage.readThemePreferences()).toBeNull(); // invalid id = malformed doc
  });

  it('seeds once from the legacy globals, persisting the scoped copy', async () => {
    mod = await freshModule();
    mod.runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: 'http://a.test' });
    const { storage } = mod!;
    window.localStorage.setItem('themeMode', 'light');
    window.localStorage.setItem('lightThemeId', 'mono');
    expect(storage.readThemePreferences()).toEqual({
      themeMode: 'light',
      lightThemeId: 'mono',
      darkThemeId: 'notnative-dark',
    });
    expect('useSystemTheme' in window.localStorage).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(SCOPED)!)).toEqual({
      themeMode: 'light',
      lightThemeId: 'mono',
      darkThemeId: 'notnative-dark',
    });
  });

  it('maps selectedThemeId/selectedThemeVariant legacy singles into the pair', async () => {
    mod = await freshModule();
    mod.runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: 'http://a.test' });
    const { storage } = mod!;
    window.localStorage.setItem('themeMode', 'dark');
    window.localStorage.setItem('selectedThemeId', 'dracula');
    window.localStorage.setItem('selectedThemeVariant', 'dark');
    expect(storage.readThemePreferences()).toEqual({
      themeMode: 'dark',
      lightThemeId: 'notnative-light',
      darkThemeId: 'dracula',
    });
  });

  it('writes the splash mirror keys under intent-shaped calls', async () => {
    const { storage } = mod!;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ themes: [] }) })));
    storage.writeThemeMirror(
      { themeMode: 'system', lightThemeId: 'a', darkThemeId: 'b' },
      { bgLight: '#ffffff', fgLight: '#000000', bgDark: '#0a0a0a', fgDark: '#ffffff' },
      'dark',
    );
    expect(window.localStorage.getItem('themeMode')).toBe('system');
    expect(window.localStorage.getItem('useSystemTheme')).toBe('true');
    expect(window.localStorage.getItem('selectedThemeVariant')).toBe('dark');
    expect(window.localStorage.getItem('splashBgDark')).toBe('#0a0a0a');
    expect(window.localStorage.getItem('splashFgLight')).toBe('#000000');
    expect(window.localStorage.getItem('notnative.themeMode')).toBe('system');
    expect(window.localStorage.getItem('selectedThemeId')).toBe('b'); // active (dark) slot
  });

  it('adopts same-runtime scoped-key storage events only', async () => {
    mod = await freshModule();
    mod.runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: 'http://a.test' });
    const { storage } = mod!;
    const seen: (ThemePreferences | null)[] = [];
    const off = storage.subscribeThemeStorageChanges((prefs) => seen.push(prefs));
    window.dispatchEvent(new StorageEvent('storage', { key: 'other.key', newValue: null }));
    expect(seen).toEqual([]);
    const payload = JSON.stringify({ themeMode: 'light', lightThemeId: 'mono', darkThemeId: 'vesper' });
    window.dispatchEvent(new StorageEvent('storage', { key: SCOPED, newValue: payload }));
    expect(seen[0]).toEqual({ themeMode: 'light', lightThemeId: 'mono', darkThemeId: 'vesper' });
    window.dispatchEvent(new StorageEvent('storage', { key: SCOPED, newValue: 'garbage' }));
    expect(seen[1]).toBeNull();
    off();
  });
});
