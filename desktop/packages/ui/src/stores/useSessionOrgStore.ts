// SPDX-License-Identifier: Apache-2.0
/**
 * Session-organization store: the UI projection over the NND-owned
 * `/api/session-org` records, keyed by normalized directory then session id.
 * Writes go through the server ops and the answered record updates this
 * store, so render-path readers stay synchronous after a load.
 */
import { create, type StoreApi, type UseBoundStore, type Mutate } from 'zustand';
import { loadSessionOrg, postSessionOrgOp, type SessionOrgOp, type SessionOrgRecord } from '../lib/session-org.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

interface SessionOrgState {
  recordsByDirectory: Record<string, Record<string, SessionOrgRecord>>;
  loadedDirectories: Record<string, true>;
  lastError: string | null;
  load: (directory: string) => Promise<void>;
  applyOp: (directory: string, sessionID: string, op: SessionOrgOp,
    extra?: Record<string, unknown>) => Promise<SessionOrgRecord>;
  forget: (directory: string) => void;
}

async function loadInner(state: SessionOrgState, directory: string): Promise<Partial<SessionOrgState>> {
  const result = await loadSessionOrg(directory);
  if (!result.ok) return { lastError: result.error };
  return {
    recordsByDirectory: { ...state.recordsByDirectory, [directory]: result.records },
    loadedDirectories: { ...state.loadedDirectories, [directory]: true },
    lastError: null,
  };
}

export const useSessionOrgStore: UseBoundStore<Mutate<StoreApi<SessionOrgState>, []>> = create<SessionOrgState>((set, get) => ({
  recordsByDirectory: {},
  loadedDirectories: {},
  lastError: null,
  load: async (directory) => {
    set(await loadInner(get(), normalizeDirectory(directory)));
  },
  applyOp: async (directory, sessionID, op, extra = {}) => {
    const key = normalizeDirectory(directory);
    if (get().loadedDirectories[key] !== true) await get().load(key);
    const result = await postSessionOrgOp(key, sessionID, op, extra);
    if (!result.ok) throw new Error(result.error);
    set((state) => ({
      recordsByDirectory: { ...state.recordsByDirectory,
        [key]: { ...state.recordsByDirectory[key], [sessionID]: result.record } },
    }));
    return result.record;
  },
  forget: (directory) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const records = { ...state.recordsByDirectory };
      delete records[key];
      const loaded = { ...state.loadedDirectories };
      delete loaded[key];
      return { recordsByDirectory: records, loadedDirectories: loaded };
    });
  },
}));

export function orgRecordOf(directory: string, sessionID: string): SessionOrgRecord | undefined {
  return useSessionOrgStore.getState().recordsByDirectory[normalizeDirectory(directory)]?.[sessionID];
}

export function __resetSessionOrgStoreForTests(): void {
  useSessionOrgStore.setState({ recordsByDirectory: {}, loadedDirectories: {}, lastError: null });
}
