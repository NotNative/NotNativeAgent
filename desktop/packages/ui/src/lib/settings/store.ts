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
let nativeWriter: ((key: string, value: unknown) => void) | null = null;
export function installNativeSettingsWriter(writer: (key: string, value: unknown) => void): () => void {
  nativeWriter = writer;
  return () => { if (nativeWriter === writer) nativeWriter = null; };
}

/** Wire once at app boot: bootstrap-grade sync + synced-event adoption. */
export function bindSettingsBridge(): () => void {
  let active = true;
  void startSettingsSync({ bootstrap: true, adoptTheme: true })
    .then((doc) => {
      if (active && doc === null) useSettingsStore.setState({ loading: false, loadError: true });
    });
  const off = onSettingsSynced((detail: SettingsSyncDetail) => {
    if (!active) return;
    useSettingsStore.setState({ doc: detail.settings, loading: false, loadError: false });
  });
  void loadDesktopSettings().then((doc) => {
    if (active && doc !== null && useSettingsStore.getState().loading) {
      useSettingsStore.setState({ doc, loading: false, loadError: false });
    }
  });
  return () => { active = false; off(); };
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
  if (nativeWriter) { nativeWriter(key, value); return; }
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
