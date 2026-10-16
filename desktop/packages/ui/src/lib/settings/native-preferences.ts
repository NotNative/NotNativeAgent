// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { runtimeFetch } from '../runtime-fetch.ts';
import { installNativeSettingsWriter, useSettingsStore } from './store.ts';
import { adoptNativePreferences } from './persistence.ts';
import { parseNativePreferencePatch } from './native-registry.ts';
import { getRuntimeKey, getApiBaseUrlActive } from '../runtime-switch.ts';

type State = { status: 'loading' | 'saved' | 'saving' | 'error' | 'conflict'; error: string };
export const useNativePreferenceState = create<State>(() => ({ status: 'loading', error: '' }));
let reload: (() => Promise<void>) | null = null;
let retry: (() => Promise<void>) | null = null;
export const reloadNativePreferences = async (): Promise<void> => { await reload?.(); };
export const retryNativePreferences = async (): Promise<void> => { await retry?.(); };

async function readPreferences(signal: AbortSignal): Promise<{ revision: number; settings: Record<string, unknown> }> {
  const response = await runtimeFetch('/api/ui-preferences', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error('Could not load saved settings.');
  const row = await response.json(), settings = parseNativePreferencePatch(row.settings);
  if (!settings || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Saved settings are invalid.');
  return { revision: row.revision, settings };
}

function confirmedSettings(row: { revision: number; settings: unknown }, revision: number, patch: Record<string, unknown>): Record<string, unknown> {
  const settings = parseNativePreferencePatch(row.settings);
  if (!settings || row.revision !== revision + 1) throw new Error('The service did not confirm the saved settings. Reload to check the saved values.');
  if (Object.entries(patch).some(([key, value]) => JSON.stringify(settings[key]) !== JSON.stringify(value))) throw new Error('The service did not apply this settings change.');
  return settings;
}

function flushOnPageHide(flush: () => Promise<void>): () => void {
  const listener = (): void => { void flush(); };
  window.addEventListener('pagehide', listener);
  return () => window.removeEventListener('pagehide', listener);
}

function applyLoadedPreferences(settings: Record<string, unknown>): void {
  useSettingsStore.setState({ doc: settings, loading: false, loadError: false });
  adoptNativePreferences({ ...settings, themeVariant: settings.themeId === settings.lightThemeId ? 'light' : 'dark' });
}

/** Invariant: each connection owns its revision, pending edits, and requests. Late replies cannot reach another runtime. */
export function connectNativePreferences(): () => void {
  let active = true, revision: number | null = null, writing = false;
  const runtime = getRuntimeKey(), origin = getApiBaseUrlActive();
  const current = (): boolean => active && runtime === getRuntimeKey() && origin === getApiBaseUrlActive();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const pending = new Map<string, unknown>();
  const state = (status: State['status'], error = ''): void => { if (current()) useNativePreferenceState.setState({ status, error }); };
  useSettingsStore.setState({ doc: {}, loading: true, loadError: false });
  async function load(): Promise<void> {
    if (writing) return;
    state('loading');
    try {
      const row = await readPreferences(controller.signal);
      if (!current()) return;
      revision = row.revision; pending.clear();
      applyLoadedPreferences(row.settings); state('saved');
    } catch (error) { if (current()) { useSettingsStore.setState({ loading: false, loadError: true }); state('error', String(error)); } }
  }
  async function flush(): Promise<void> {
    if (!current() || writing || revision === null || pending.size === 0 || useNativePreferenceState.getState().status === 'conflict') return;
    writing = true; state('saving');
    const patch = Object.fromEntries(pending);
    try {
      const response = await runtimeFetch('/api/ui-preferences', { method: 'PUT', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: revision, settings: patch }) });
      if (!current()) return;
      if (response.status === 409) { state('conflict', 'Settings changed in another window. Your edits remain here. Reload saved settings to discard these edits.'); return; }
      if (!response.ok) throw new Error('Could not save settings. Your edits remain here; retry when the service is available.');
      const row = await response.json();
      if (!current()) return;
      const settings = confirmedSettings(row, revision, patch);
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(pending.get(key)) === JSON.stringify(value)) pending.delete(key);
      }
      revision = row.revision;
      const doc = { ...settings, ...Object.fromEntries(pending) };
      useSettingsStore.setState({ doc }); state(pending.size ? 'saving' : 'saved');
    } catch (error) { state('error', String(error)); }
    finally {
      writing = false;
      if (current() && pending.size && useNativePreferenceState.getState().status === 'saving') void flush();
    }
  }
  const offWriter = installNativeSettingsWriter((key, value) => {
    if (!current() || revision === null || ['loading', 'conflict'].includes(useNativePreferenceState.getState().status)) return;
    const patch = parseNativePreferencePatch({ [key]: value }); if (!patch) return;
    pending.set(key, patch[key]);
    useSettingsStore.setState({ doc: { ...useSettingsStore.getState().doc, ...patch } }); state('saving');
    if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void flush(); }, 200);
  });
  const retrySave = async (): Promise<void> => { if (revision === null) await load(); else await flush(); };
  const offHide = flushOnPageHide(flush);
  reload = load; retry = retrySave; void load();
  return () => {
    active = false; controller.abort(); if (timer) clearTimeout(timer); offWriter();
    offHide();
    if (reload === load) reload = null; if (retry === retrySave) retry = null;
  };
}
