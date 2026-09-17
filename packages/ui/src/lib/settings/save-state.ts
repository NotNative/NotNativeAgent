// SPDX-License-Identifier: Apache-2.0
/**
 * Settings save-state indicator (doc 14 §F.3): `idle|saving|error` with
 * listeners + the `notnative:settings-save-state` CustomEvent; error auto-
 * resets after 6 s. Success renders nothing (quiet indicator).
 */
export type SettingsSaveState = 'idle' | 'saving' | 'error';

const ERROR_RESET_MS = 6_000;
export const SETTINGS_SAVE_STATE_EVENT = 'notnative:settings-save-state';

const listeners = new Set<(state: SettingsSaveState) => void>();
let state: SettingsSaveState = 'idle';
let errorResetTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(): void {
  for (const listener of listeners) listener(state);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_SAVE_STATE_EVENT, { detail: state }));
  }
}

export function setSettingsSaveState(next: SettingsSaveState): void {
  // Repeat dispatches are quiet for unchanged states (per-keystroke 'saving');
  // an already-armed error keeps its single reset timer.
  if (state === next && (next !== 'error' || errorResetTimer !== null)) return;
  state = next;
  if (errorResetTimer) {
    clearTimeout(errorResetTimer);
    errorResetTimer = null;
  }
  if (next === 'error') {
    errorResetTimer = setTimeout(() => {
      errorResetTimer = null;
      state = 'idle';
      dispatch();
    }, ERROR_RESET_MS);
  }
  dispatch();
}

export function getSettingsSaveState(): SettingsSaveState {
  return state;
}

export function subscribeSettingsSaveState(listener: (saveState: SettingsSaveState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pages persisting through their own APIs report through this (§F.3). */
export function reportSettingsSaveState(next: SettingsSaveState): void {
  setSettingsSaveState(next);
}
