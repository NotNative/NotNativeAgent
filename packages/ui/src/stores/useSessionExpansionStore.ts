// SPDX-License-Identifier: Apache-2.0
/** Device-local, runtime-scoped expansion of delegated session trees. */
import { create } from 'zustand';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

const STORAGE_KEY = 'nnd.sessions.expanded.v1';
type ExpansionMap = Record<string, true>;

function key(runtimeKey: string, parentId: string): string {
  return JSON.stringify([runtimeKey, parentId]);
}

function read(): ExpansionMap {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const valid: ExpansionMap = {};
    for (const [encoded, enabled] of Object.entries(raw)) {
      if (enabled !== true) continue;
      try {
        const parts = JSON.parse(encoded) as unknown;
        if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === 'string')) valid[encoded] = true;
      } catch { /* One malformed persisted key cannot discard valid choices. */ }
    }
    return valid;
  } catch { return {}; }
}

function write(expanded: ExpansionMap): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded)); } catch { /* Keep in-memory choice. */ }
}

interface ExpansionState {
  expanded: ExpansionMap;
  toggle: (parentId: string, runtimeKey?: string) => void;
  reload: () => void;
}

export const useSessionExpansionStore = create<ExpansionState>((set, get) => ({
  expanded: read(),
  toggle: (parentId, runtimeKey = getRuntimeKey()) => {
    const encoded = key(runtimeKey, parentId);
    const expanded = { ...get().expanded };
    if (expanded[encoded]) delete expanded[encoded]; else expanded[encoded] = true;
    set({ expanded });
    write(expanded);
  },
  reload: () => set({ expanded: read() }),
}));

export function expandedParentIds(expanded: ExpansionMap, runtimeKey = getRuntimeKey()): Set<string> {
  const ids = new Set<string>();
  for (const encoded of Object.keys(expanded)) {
    try {
      const parts = JSON.parse(encoded) as unknown;
      if (Array.isArray(parts) && parts.length === 2 && parts[0] === runtimeKey && typeof parts[1] === 'string') ids.add(parts[1]);
    } catch { /* Ignore malformed external storage. */ }
  }
  return ids;
}
