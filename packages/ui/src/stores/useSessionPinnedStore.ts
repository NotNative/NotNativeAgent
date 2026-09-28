// SPDX-License-Identifier: Apache-2.0
/** Device-local session pins, isolated by runtime and normalized directory. */
import { create } from 'zustand';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';

const STORAGE_KEY = 'nnd.sessions.pinned.v1';
type PinMap = Record<string, number>;

function key(runtimeKey: string, directory: string, sessionID: string): string {
  return JSON.stringify([runtimeKey, normalizeDirectory(directory), sessionID]);
}

function read(): PinMap {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const pins: PinMap = {};
    for (const [id, touchedAt] of Object.entries(value)) {
      if (typeof touchedAt === 'number' && Number.isFinite(touchedAt) && touchedAt >= 0) {
        try {
          const parts = JSON.parse(id) as unknown;
          if (Array.isArray(parts) && parts.length === 3 && parts.every((part) => typeof part === 'string')) pins[id] = touchedAt;
        } catch { /* ignore one malformed key without losing valid pins */ }
      }
    }
    return pins;
  } catch { return {}; }
}

function write(pins: PinMap): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pins)); } catch { /* in-memory pins remain usable */ }
}

interface PinnedState {
  pins: PinMap;
  toggle: (directory: string, sessionID: string) => void;
  clear: (directory: string, sessionID: string, runtimeKey?: string) => void;
  reload: () => void;
}

export const useSessionPinnedStore = create<PinnedState>((set, get) => ({
  pins: read(),
  toggle: (directory, sessionID) => {
    const runtimeKey = getRuntimeKey();
    if (isTransientRuntimeKey(runtimeKey)) return;
    const id = key(runtimeKey, directory, sessionID);
    const pins = { ...get().pins };
    if (id in pins) delete pins[id]; else pins[id] = Date.now();
    set({ pins }); write(pins);
  },
  clear: (directory, sessionID, runtimeKey = getRuntimeKey()) => {
    const id = key(runtimeKey, directory, sessionID);
    if (!(id in get().pins)) return;
    const pins = { ...get().pins };
    delete pins[id];
    set({ pins }); write(pins);
  },
  reload: () => set({ pins: read() }),
}));

export function pinnedSessionIds(pins: PinMap, directory: string, runtimeKey = getRuntimeKey()): Set<string> {
  if (isTransientRuntimeKey(runtimeKey)) return new Set();
  const ids = new Set<string>();
  for (const encoded of Object.keys(pins)) {
    try {
      const parts = JSON.parse(encoded) as unknown;
      if (Array.isArray(parts) && parts.length === 3 && parts.every((part) => typeof part === 'string')
        && parts[0] === runtimeKey && parts[1] === normalizeDirectory(directory)) ids.add(parts[2] as string);
    } catch { /* malformed external storage is ignored */ }
  }
  return ids;
}
