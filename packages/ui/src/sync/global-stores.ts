// SPDX-License-Identifier: Apache-2.0
/**
 * Global sidecar stores (doc 04 §A.2 + Appendix 2). These NEVER merge with
 * directory child stores: the live status index is the only source of
 * busy/retry indicators; the global sessions cache is cold sidebar coverage.
 */
import { create } from 'zustand';
import { harnessClient } from '../lib/nnd/client.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import { stripSessionListDetails } from './sanitize.ts';

// ── live status index (events + authoritative snapshots ONLY) ──────────────
interface GlobalStatusState {
  statusById: Record<string, SessionStatus>;
  activeSessionIds: string[];
  applyEvent: (sessionID: string, status: SessionStatus) => void;
  /** authoritative: absence of a candidate ⇒ explicit idle (sets ready gate)
   *  monotonic: confirm/raise only, NEVER lowers — a blind poll cannot clobber live state */
  applySnapshot: (snapshot: Record<string, SessionStatus>, candidateSessionIds: string[], mode: 'authoritative' | 'monotonic') => void;
  removeSession: (sessionID: string) => void;
  reset: () => void;
}

const isActiveStatus = (status: SessionStatus | undefined): boolean =>
  status !== undefined && status.type !== 'idle';

function recency(status: SessionStatus | undefined): number {
  if (!status || status.type !== 'retry') return 0;
  return status.next ?? 0;
}

export const useGlobalSessionStatusStore = create<GlobalStatusState>((set, get) => ({
  statusById: {},
  activeSessionIds: [],
  applyEvent: (sessionID, status) => {
    const next = { ...get().statusById };
    if (status.type === 'idle') delete next[sessionID];
    else next[sessionID] = status;
    set({ statusById: next, activeSessionIds: Object.keys(next).filter((id) => isActiveStatus(next[id])) });
  },
  applySnapshot: (snapshot, candidateSessionIds, mode) => {
    const next = { ...get().statusById };
    for (const id of candidateSessionIds) {
      const incoming = snapshot[id];
      if (incoming) {
        if (mode === 'monotonic') {
          const current = next[id];
          const currentActive = isActiveStatus(current);
          const incomingActive = isActiveStatus(incoming);
          if (currentActive && !incomingActive) continue; // monotonic never lowers
          if (currentActive && incomingActive && current?.type === 'retry' && incoming.type !== 'retry' && recency(current) > Date.now()) continue;
        }
        next[id] = incoming;
      } else if (mode === 'authoritative') {
        delete next[id]; // explicit idle for covered candidates
      }
    }
    set({ statusById: next, activeSessionIds: Object.keys(next).filter((id) => isActiveStatus(next[id])) });
  },
  removeSession: (sessionID) => {
    if (!(sessionID in get().statusById)) return;
    const next = { ...get().statusById };
    delete next[sessionID];
    set({ statusById: next, activeSessionIds: Object.keys(next).filter((id) => isActiveStatus(next[id])) });
  },
  reset: () => set({ statusById: {}, activeSessionIds: [] }),
}));

// ── global sessions cache (inclusive fetch + client-side archived split) ───
interface GlobalSessionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  active: Session[];
  archived: Session[];
  directoryOf: Record<string, string>;
  hasLoaded: boolean;
  lastError: string | null;
  loadSessions: () => Promise<void>;
  upsertSession: (session: Session) => void;
  removeSession: (sessionID: string) => void;
  reset: () => void;
}

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  status: 'idle',
  active: [],
  archived: [],
  directoryOf: {},
  hasLoaded: false,
  lastError: null,
  async loadSessions() {
    const result = await harnessClient.listSessions({ archived: true });
    if (result.error || !result.data) {
      // failure preserves the previous snapshot — never an empty success
      set({ status: 'error', lastError: result.error ?? 'session list failed' });
      return;
    }
    const sessions = result.data.map((session) => stripSessionListDetails({ ...session }));
    const active: Session[] = [];
    const archived: Session[] = [];
    const directoryOf: Record<string, string> = {};
    for (const session of sessions) {
      directoryOf[session.id] = session.directory ?? '';
      if (session.time.archived) archived.push(session);
      else active.push(session);
    }
    set({ status: 'ready', active, archived, directoryOf, hasLoaded: true, lastError: null });
  },
  upsertSession: (session) => {
    const replaceIn = (list: Session[]) => {
      const index = list.findIndex((s) => s.id === session.id);
      if (index < 0) return [...list, session];
      const next = [...list];
      next[index] = session;
      return next;
    };
    if (session.time.archived) {
      set({ active: get().active.filter((s) => s.id !== session.id), archived: replaceIn(get().archived) });
    } else {
      set({ archived: get().archived.filter((s) => s.id !== session.id), active: replaceIn(get().active) });
    }
    set({ directoryOf: { ...get().directoryOf, [session.id]: session.directory ?? '' } });
  },
  removeSession: (sessionID) => {
    const directoryOf = { ...get().directoryOf };
    delete directoryOf[sessionID];
    set({ active: get().active.filter((s) => s.id !== sessionID), archived: get().archived.filter((s) => s.id !== sessionID), directoryOf });
  },
  reset: () => set({ status: 'idle', active: [], archived: [], directoryOf: {}, hasLoaded: false, lastError: null }),
}));

// ── global sync store (path/projects/config readiness + reload signal) ─────
interface GlobalSyncState {
  ready: boolean;
  error: string | null;
  path: Record<string, unknown> | null;
  projects: Record<string, unknown>[];
  config: Record<string, unknown> | null;
  reload: 'idle' | 'pending';
  set: (partial: Partial<Omit<GlobalSyncState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

export const useGlobalSyncStore = create<GlobalSyncState>((set) => ({
  ready: false,
  error: null,
  path: null,
  projects: [],
  config: null,
  reload: 'idle',
  set: (partial) => set(partial),
  reset: () => set({ ready: false, error: null, path: null, projects: [], config: null, reload: 'idle' }),
}));
