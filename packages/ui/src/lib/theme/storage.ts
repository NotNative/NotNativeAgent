// SPDX-License-Identifier: Apache-2.0
/**
 * Theme preference persistence (doc 14 §E.3): runtimeKey-scoped localStorage
 * (`notnative.theme.v2:<enc runtimeKey>`) + the legacy global mirror keys the
 * pre-React splash shells still read. Transient runtime keys never read or
 * write; malformed scoped payloads validate to null.
 */
import { getRuntimeKey, isTransientRuntimeKey, onRuntimeEndpointChanged } from '../runtime-switch.ts';
import type { ThemeVariant } from './types.ts';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ThemePreferences {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
}

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  themeMode: 'system',
  lightThemeId: 'notnative-light',
  darkThemeId: 'notnative-dark',
};

const SCOPED_PREFIX = 'notnative.theme.v2:';
const MODES: ThemeMode[] = ['system', 'light', 'dark'];

export function scopedThemeStorageKey(runtimeKey: string): string {
  return `${SCOPED_PREFIX}${encodeURIComponent(runtimeKey)}`;
}

function activeStorageKey(): string | null {
  const runtimeKey = getRuntimeKey();
  return isTransientRuntimeKey(runtimeKey) ? null : scopedThemeStorageKey(runtimeKey);
}

function validId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function parseThemePreferences(raw: unknown): ThemePreferences | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const mode = record.themeMode;
  if (typeof mode !== 'string' || !MODES.includes(mode as ThemeMode)) return null;
  // §E.3 "malformed = null = keep current": ids must be present strings.
  if (typeof record.lightThemeId !== 'string' || record.lightThemeId.trim().length === 0) return null;
  if (typeof record.darkThemeId !== 'string' || record.darkThemeId.trim().length === 0) return null;
  return {
    themeMode: mode as ThemeMode,
    lightThemeId: record.lightThemeId.trim(),
    darkThemeId: record.darkThemeId.trim(),
  };
}

/** Null when the runtime key is transient or the stored payload is malformed. */
export function readThemePreferences(): ThemePreferences | null {
  const key = activeStorageKey();
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return seedFromLegacyKeys(key);
    return parseThemePreferences(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** One-time seed path (§E.3): legacy globals seed the scoped document, which
 * is then persisted once (adoption-grade, no later echo). */
function seedFromLegacyKeys(key: string): ThemePreferences | null {
  try {
    const store = window.localStorage;
    const useSystem = store.getItem('useSystemTheme');
    const rawMode = useSystem === 'true' ? 'system' : store.getItem('themeMode');
    if (typeof rawMode !== 'string' || !MODES.includes(rawMode as ThemeMode)) return null;
    const singleThemeId = store.getItem('selectedThemeId');
    const singleVariant = store.getItem('selectedThemeVariant');
    const legacy: ThemePreferences = {
      themeMode: rawMode as ThemeMode,
      lightThemeId: validId(store.getItem('lightThemeId') ?? (singleVariant === 'light' ? singleThemeId : null), DEFAULT_THEME_PREFERENCES.lightThemeId),
      darkThemeId: validId(store.getItem('darkThemeId') ?? (singleVariant === 'dark' ? singleThemeId : null), DEFAULT_THEME_PREFERENCES.darkThemeId),
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(legacy)); // write once
    } catch { /* seeding survives without the persisted copy */ }
    return legacy;
  } catch {
    return null;
  }
}

/**
 * Dropped silently for transient runtimes (§E.3 rule; no writes at boot).
 * False return = no write happened, so callers can keep a pending intent.
 */
export function writeThemePreferences(prefs: ThemePreferences): boolean {
  const key = activeStorageKey();
  if (!key) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
    return true;
  } catch {
    return false; // storage unavailable (private mode) — prefs stay in-memory
  }
}

/**
 * Splash mirror (§E.3): legacy keys for pre-React shells PLUS the branded
 * `notnative.themeMode` key the shipped web splash index.html reads.
 */
export function writeThemeMirror(
  prefs: ThemePreferences,
  colors: { bgLight: string; fgLight: string; bgDark: string; fgDark: string },
  variant: ThemeVariant,
): void {
  try {
    const store = window.localStorage;
    store.setItem('themeMode', prefs.themeMode);
    store.setItem('notnative.themeMode', prefs.themeMode);
    store.setItem('useSystemTheme', String(prefs.themeMode === 'system'));
    store.setItem('selectedThemeVariant', variant);
    store.setItem('selectedThemeId', variant === 'dark' ? prefs.darkThemeId : prefs.lightThemeId);
    store.setItem('lightThemeId', prefs.lightThemeId);
    store.setItem('darkThemeId', prefs.darkThemeId);
    for (const [name, value] of Object.entries(colors)) store.setItem(`splash${cap(name)}`, value);
  } catch { /* mirror best-effort only */ }
}

const cap = (name: string): string => (name[0]?.toUpperCase() ?? '') + name.slice(1);

/** Cross-window adoption (§E.3): same-runtime scoped-key storage events. */
export function subscribeThemeStorageChanges(listener: (prefs: ThemePreferences | null) => void): () => void {
  const handler = (event: StorageEvent): void => {
    const key = activeStorageKey();
    if (!key || event.key !== key) return;
    listener(parseThemePreferences(safeParse(event.newValue)));
  };
  window.addEventListener('storage', handler);
  const endpointOff = onRuntimeEndpointChanged(() => listener(readThemePreferences()));
  return () => {
    window.removeEventListener('storage', handler);
    endpointOff();
  };
}

function safeParse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
