// SPDX-License-Identifier: Apache-2.0
/**
 * Settings state store (doc 14 §F.3 apply step): the registry-parsed server
 * document lands HERE (via the persistence bridge) and pages read from it;
 * writes go back through updateDesktopSettings with an optimistic local
 * merge (the pending buffer overlays make GETs race-free, and successful
 * flushes update serverKnown so the echo never fights this store).
 */
import { create } from 'zustand';
import { onSettingsSynced, loadDesktopSettings, updateDesktopSettings, startSettingsSync, type SettingsSyncDetail } from './persistence.ts';
import { parseSettingsDocument, SURFACE_ECHO_KEY } from './parse.ts';
import { getSettingsField } from './registry.ts';

export interface SettingsState {
  doc: Record<string, unknown>;
  loading: boolean;
  loadError: boolean;
}

export const useSettingsStore = create<SettingsState>(() => ({ doc: {}, loading: true, loadError: false }));

/** Wire once at app boot: bootstrap-grade sync + synced-event adoption. */
export function bindSettingsBridge(): void {
  void startSettingsSync({ bootstrap: true, adoptTheme: true })
    .then((doc) => {
      if (doc === null) useSettingsStore.setState({ loading: false, loadError: true });
    });
  onSettingsSynced((detail: SettingsSyncDetail) => {
    useSettingsStore.setState({ doc: detail.settings, loading: false, loadError: false });
  });
  void loadDesktopSettings().then((doc) => {
    if (doc !== null && useSettingsStore.getState().loading) {
      useSettingsStore.setState({ doc, loading: false, loadError: false });
    }
  });
}

/** Test isolation. */
export function __resetSettingsStoreForTests(): void {
  useSettingsStore.setState({ doc: {}, loading: true, loadError: false });
}

export function settingsValue<T>(key: string): T | undefined {
  return useSettingsStore.getState().doc[key] as T | undefined;
}

/** Optimistic write: merge locally, then the debounced PUT carries it. */
export function setSettingsField(key: string, value: unknown): void {
  const field = getSettingsField(key);
  const { doc } = useSettingsStore.getState();
  if (!field) return; // unregisterable keys never persist (§K2)
  const parsed = field.parse(value);
  const next = { ...doc, [key]: parsed ?? undefined } as Record<string, unknown>;
  if (parsed === null) delete next[key];
  useSettingsStore.setState({ doc: next, loading: false });
  updateDesktopSettings({ [key]: value });
}

// Surfaced for page-owned extra reads (usage page pattern).
export { parseSettingsDocument, SURFACE_ECHO_KEY };
