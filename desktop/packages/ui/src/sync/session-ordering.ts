// SPDX-License-Identifier: Apache-2.0
/**
 * Session list ordering (doc 04 §F.10): lifecycle ranks promoted EXACTLY on
 * settled↔active crossings; rank compared only WITHIN scope (roots vs roots,
 * children vs same-parent siblings); frozen baseline desc; NEVER time.updated.
 */
import { create } from 'zustand';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';

export type LifecyclePhase = 'unknown' | 'active' | 'settled';

interface OrderingState {
  rankById: Record<string, number>;
  observeStatus: (sessionID: string, status: SessionStatus) => void;
  /** authoritative snapshot reconciles transitions missed while disconnected
   * (batch shares ONE rank; ties broken by timestamps) */
  reconcileSnapshot: (entries: { sessionID: string; status: SessionStatus }[]) => void;
  promoteNow: (sessionIDs: string[]) => void;
  remove: (sessionID: string) => void;
  reset: () => void;
}

const phaseOf = (status: SessionStatus | undefined): LifecyclePhase => {
  if (!status) return 'unknown';
  return status.type === 'idle' ? 'settled' : 'active';
};

let lastRank = 0;
const baselineRank = new Map<string, number>(); // FROZEN at first participation
const phases = new Map<string, LifecyclePhase>();

function nextRank(): number {
  lastRank = Math.max(lastRank + 1, Date.now());
  return lastRank;
}

function freezeBaseline(sessionID: string, session: { time: { created: number; updated: number } } | undefined): void {
  if (baselineRank.has(sessionID)) return;
  const stamp = session ? session.time.updated : 0; // pinned sessions would freeze created (deferred: no pins in P2)
  baselineRank.set(sessionID, stamp);
}

export const useSessionOrderingStore = create<OrderingState>((set, get) => ({
  rankById: {},
  observeStatus: (sessionID, status) => {
    const phase = phaseOf(status);
    const previous = phases.get(sessionID) ?? 'unknown';
    phases.set(sessionID, phase);
    if (previous === phase) return; // repeated busy/retry or idle/error are no-ops
    if (previous === 'unknown') return; // first authoritative phase sets the baseline, no promotion
    const crossed =
      (previous === 'settled' && phase === 'active') ||
      (previous === 'active' && (phase === 'settled'));
    if (!crossed) return;
    set({ rankById: { ...get().rankById, [sessionID]: nextRank() } });
  },
  reconcileSnapshot: (entries) => {
    const missed = entries.filter((entry) => {
      const phase = phaseOf(entry.status);
      const previous = phases.get(entry.sessionID) ?? 'unknown';
      phases.set(entry.sessionID, phase);
      return previous !== 'unknown' && previous !== phase;
    });
    if (missed.length === 0) return;
    const rank = nextRank(); // a batch shares ONE rank
    const rankById = { ...get().rankById };
    for (const entry of missed) rankById[entry.sessionID] = rank;
    set({ rankById });
  },
  promoteNow: (sessionIDs) => {
    const rank = nextRank();
    const rankById = { ...get().rankById };
    for (const id of sessionIDs) rankById[id] = rank;
    set({ rankById });
  },
  remove: (sessionID) => {
    phases.delete(sessionID);
    baselineRank.delete(sessionID);
    if (!(sessionID in get().rankById)) return;
    const rankById = { ...get().rankById };
    delete rankById[sessionID];
    set({ rankById });
  },
  reset: () => {
    phases.clear();
    baselineRank.clear();
    lastRank = 0;
    set({ rankById: {} });
  },
}));

export interface OrderingSessionRecord {
  id: string;
  parentID?: string;
  time: { created: number; updated: number };
}

function compareWithinScope(a: OrderingSessionRecord, b: OrderingSessionRecord, rankById: Record<string, number>): number {
  const ra = rankById[a.id] ?? baselineRank.get(a.id) ?? 0;
  const rb = rankById[b.id] ?? baselineRank.get(b.id) ?? 0;
  if (ra !== rb) return rb - ra; // ranks/baselines are NEWER-HIGHER
  // §F.10 invariant: NEVER sort lists by time.updated — created desc, id asc
  if (a.time.created !== b.time.created) return b.time.created - a.time.created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The user-visible order for every session list. GENERIC so the ORIGINAL
 * records flow back out untouched — callers rely on the full shape
 * (title/directory), which the earlier {id,parentID,time} projection strip
 * destroyed ("Untitled Session" regression). */
export function orderSessionsByLifecycle<T extends OrderingSessionRecord>(sessions: T[]): T[] {
  const rankById = useSessionOrderingStore.getState().rankById;
  for (const session of sessions) freezeBaseline(session.id, session);
  const roots = sessions.filter((s) => !s.parentID);
  const childrenByParent = new Map<string, T[]>();
  const known = new Set(sessions.map((s) => s.id));
  for (const session of sessions) {
    if (!session.parentID) continue;
    if (known.has(session.parentID)) {
      const list = childrenByParent.get(session.parentID) ?? [];
      list.push(session);
      childrenByParent.set(session.parentID, list);
    }
  }
  roots.sort((a, b) => compareWithinScope(a, b, rankById));
  const ordered: T[] = [];
  const visited = new Set<string>();
  const appendBranch = (session: T): void => {
    if (visited.has(session.id)) return; // cycle guard
    visited.add(session.id);
    ordered.push(session);
    const children = (childrenByParent.get(session.id) ?? []).sort((a, b) => compareWithinScope(a, b, rankById));
    for (const child of children) appendBranch(child);
  };
  for (const root of roots) {
    appendBranch(root);
  }
  // Orphans and malformed cycles have no root. They remain visible, but never
  // masquerade as descendants of an unseen parent.
  const remaining = sessions.filter((s) => !visited.has(s.id)).sort((a, b) => compareWithinScope(a, b, rankById));
  for (const session of remaining) appendBranch(session);
  return ordered;
}
