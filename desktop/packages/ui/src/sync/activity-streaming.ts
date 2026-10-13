// SPDX-License-Identifier: Apache-2.0
/**
 * Turn timing (doc 04 §F.10) + streaming lifecycle (doc 04 §H.1).
 * A busy event NEVER starts a clock — busy means "still running". Only live
 * idle/error settles or a COVERED snapshot's silence for sessions with a LIVE
 * start in this page session. Single storage key, NOT runtime-scoped by design.
 */
import { create } from 'zustand';
import type { SessionStatus } from '../lib/nnd/types.ts';

const ACTIVITY_KEY = 'nnd.session-activity.v1';
const SETTLED_LIMIT = 200;
const LIVENESS_PERSIST_INTERVAL_MS = 15_000;
const MAX_AWAY_MS = 30_000;
const RESTORE_ADOPTION_WINDOW_MS = 90_000;
const MAX_TURN_AGE_MS = 24 * 60 * 60_000;

type ActivityRecords = Record<string, { start: number; seen: number }>;

const pageLoadAt = typeof performance !== 'undefined' ? performance.timeOrigin ?? Date.now() : Date.now();
const startedAt = new Map<string, number>(); // live + adopted
const settledMs = new Map<string, number>();
const liveStarts = new Set<string>(); // started within THIS page session
let lastLivenessWrite = 0;
let adoptedAny = false;

function readRecords(): ActivityRecords {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? '') as ActivityRecords;
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const out: ActivityRecords = {};
    for (const [id, record] of Object.entries(parsed)) {
      if (!record || typeof record.start !== 'number' || typeof record.seen !== 'number') continue;
      if (record.start <= 0 || record.start > now) continue; // malformed/negative/future
      if (now - record.start > MAX_TURN_AGE_MS) continue; // sanity cap
      out[id] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRecords(records: ActivityRecords): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(records));
  } catch {
    /* best-effort */
  }
}

export function adoptPersistedActivity(): void {
  if (adoptedAny) return;
  adoptedAny = true;
  const records = readRecords();
  if (Object.keys(records).length === 0) return;
  const withinAdoption = Date.now() - pageLoadAt <= RESTORE_ADOPTION_WINDOW_MS;
  if (!withinAdoption) {
    writeRecords({}); // unclaimed records past the window are discarded
    return;
  }
  for (const [sessionID, record] of Object.entries(records)) {
    if (Date.now() - record.seen > MAX_AWAY_MS) continue; // away too long: unobservable
    if (!startedAt.has(sessionID)) {
      startedAt.set(sessionID, record.start); // persisted start adopted, timer continues
    }
  }
}

/** busy NEVER starts the clock; it prefers the persisted start. */
export function observeActivityOnBusy(sessionID: string): void {
  if (startedAt.has(sessionID)) {
    touchLiveness(sessionID);
    return;
  }
  const records = readRecords();
  const record = records[sessionID];
  const now = Date.now();
  if (record && now - record.seen <= MAX_AWAY_MS && now - pageLoadAt <= RESTORE_ADOPTION_WINDOW_MS) {
    startedAt.set(sessionID, record.start);
    touchLiveness(sessionID);
  }
}

export function settleActivity(sessionID: string, kind: 'idle' | 'error'): void {
  const start = startedAt.get(sessionID);
  if (start === undefined) return;
  const duration = Math.max(0, Date.now() - start);
  settledMs.set(sessionID, duration);
  while (settledMs.size > SETTLED_LIMIT) {
    const first = settledMs.keys().next();
    if (first.done) break;
    settledMs.delete(first.value);
  }
  startedAt.delete(sessionID);
  liveStarts.delete(sessionID);
  const records = readRecords();
  if (records[sessionID]) {
    delete records[sessionID]; // retire the persisted record on live settle
    writeRecords(records);
  }
}

/** COVERED-snapshot silence settles only sessions with a LIVE start here. */
export function settleFromCoveredSnapshot(sessionID: string): void {
  if (!liveStarts.has(sessionID)) return; // absent-status is never evidence
  settleActivity(sessionID, 'idle');
}

export function markLiveStart(sessionID: string): void {
  liveStarts.add(sessionID);
  startedAt.set(sessionID, Date.now());
  touchLiveness(sessionID);
}

function touchLiveness(sessionID: string): void {
  const records = readRecords();
  records[sessionID] = { start: startedAt.get(sessionID) ?? 0, seen: Date.now() };
  if (Date.now() - lastLivenessWrite >= LIVENESS_PERSIST_INTERVAL_MS) {
    lastLivenessWrite = Date.now();
    writeRecords(records);
  } else {
    pendingLiveness = records;
  }
}

let pendingLiveness: ActivityRecords | null = null;

export function flushActivityLiveness(): void {
  if (pendingLiveness) {
    writeRecords(pendingLiveness);
    pendingLiveness = null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushActivityLiveness);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushActivityLiveness();
  });
  (window as unknown as { addEventListener: (k: string, f: () => void) => void }).addEventListener('freeze', flushActivityLiveness);
}

export function getStartedAt(sessionID: string): number | undefined {
  return startedAt.get(sessionID);
}

export function getSettledDurationMs(sessionID: string): number | undefined {
  return settledMs.get(sessionID);
}

export function hasSessionActivity(sessionID: string): boolean {
  return startedAt.has(sessionID) || settledMs.has(sessionID);
}

export function resetActivityTiming(): void {
  startedAt.clear();
  settledMs.clear();
  liveStarts.clear();
  pendingLiveness = null;
}

// ── streaming store (H.1): a MESSAGE lifecycle, not a turn lifecycle ────────
export type StreamPhase = 'streaming' | 'cooldown' | 'completed';
interface StreamState {
  phase: StreamPhase;
  startedAt: number;
  lastUpdateAt: number;
  completedAt?: number;
}
interface StreamingState {
  streamingMessageIds: Record<string, string | null>;
  messageStreamStates: Record<string, StreamState>;
  /** full reconciliation from authoritative state */
  reconcile: (input: { sessionID: string; busy: boolean; trailingAssistant: { id: string; completed: boolean } | null }) => void;
  touchStreamingSession: (messageID: string) => void;
  clearSession: (sessionID: string) => void;
  reset: () => void;
}

const STREAMING_HEARTBEAT_MS = 1_000;
const lastHeartbeatAt = new Map<string, number>();

export const useStreamingStore = create<StreamingState>((set, get) => ({
  streamingMessageIds: {},
  messageStreamStates: {},
  reconcile: ({ sessionID, busy, trailingAssistant }) => {
    const streamingMessageIds = { ...get().streamingMessageIds };
    const messageStreamStates = { ...get().messageStreamStates };
    const current = streamingMessageIds[sessionID] ?? null;
    const now = Date.now();
    // trailing message stamped completed is NEVER streaming, even while busy
    const candidate = busy && trailingAssistant && !trailingAssistant.completed ? trailingAssistant.id : null;
    if (candidate === current) return;
    if (current) {
      const state = messageStreamStates[current];
      if (state) messageStreamStates[current] = { ...state, phase: 'completed', completedAt: now };
    }
    if (candidate) {
      const state = messageStreamStates[candidate];
      messageStreamStates[candidate] = state
        ? { ...state, phase: 'streaming', lastUpdateAt: now }
        : { phase: 'streaming', startedAt: now, lastUpdateAt: now };
    }
    streamingMessageIds[sessionID] = candidate;
    set({ streamingMessageIds, messageStreamStates });
  },
  touchStreamingSession: (messageID) => {
    const now = Date.now();
    if (now - (lastHeartbeatAt.get(messageID) ?? 0) < STREAMING_HEARTBEAT_MS) return; // 1Hz throttle
    lastHeartbeatAt.set(messageID, now);
    const state = get().messageStreamStates[messageID];
    if (!state || state.phase !== 'streaming') return;
    set({ messageStreamStates: { ...get().messageStreamStates, [messageID]: { ...state, lastUpdateAt: now } } });
  },
  clearSession: (sessionID) => {
    const streamingMessageIds = { ...get().streamingMessageIds };
    const current = streamingMessageIds[sessionID];
    delete streamingMessageIds[sessionID];
    const messageStreamStates = { ...get().messageStreamStates };
    if (current) delete messageStreamStates[current];
    set({ streamingMessageIds, messageStreamStates });
  },
  reset: () => set({ streamingMessageIds: {}, messageStreamStates: {} }),
}));
