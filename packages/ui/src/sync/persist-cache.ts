// SPDX-License-Identifier: Apache-2.0
/**
 * Persisted continuity caches (doc 04 §G.1/G.2 — P2 subset). Principles:
 * stale cache NEVER authority; failure is not empty; runtime scoping;
 * debounced writes with lifecycle flush; tombstones for explicit empty.
 */
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import type { Session } from '../lib/nnd/types.ts';

const SESSIONS_CAP = 50;
const WRITE_DEBOUNCE_MS = 50;
const FALLBACK_LADDER = [50, 25, 10, 5, 1];

type Storage = Pick<StorageLike, 'getItem' | 'setItem' | 'removeItem'>;
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    };
  } catch {
    return null;
  }
}

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function dirCacheKey(runtimeKey: string, directory: string): string {
  const head = directory.split('/').filter(Boolean).pop() ?? 'root';
  return `nnd.dir.v2.${head.slice(0, 12)}.${hash(`${runtimeKey}\u0000${directory}`)}.sessions`;
}

interface SessionsEnvelope {
  version: 2;
  runtime: string;
  directory: string;
  sessions: Session[];
}

/** Read is best-effort: malformed payloads are failed reads, never empty. */
export function readCachedSessions(directory: string): Session[] | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(dirCacheKey(getRuntimeKey(), directory));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionsEnvelope;
    if (parsed.version !== 2 || parsed.runtime !== getRuntimeKey()) return null;
    if (!Array.isArray(parsed.sessions)) return null;
    return parsed.sessions.slice(0, SESSIONS_CAP);
  } catch {
    return null;
  }
}

const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; runtimeKey: string; directory: string; sessions: Session[] }>();

export function writeCachedSessions(directory: string, sessions: Session[]): void {
  const store = storage();
  if (!store) return;
  const runtimeKey = getRuntimeKey();
  const key = dirCacheKey(runtimeKey, directory);
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    flushCachedSessions(directory, sessions, runtimeKey);
  }, WRITE_DEBOUNCE_MS);
  if (typeof timer === 'object' && typeof (timer as { unref?: unknown }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  pendingWrites.set(key, { timer, runtimeKey, directory, sessions });
}

/** Quota ladder: shrink the snapshot rather than lose the key entirely. */
export function flushCachedSessions(directory: string, sessions: Session[], runtimeKey = getRuntimeKey()): void {
  const store = storage();
  if (!store) return;
  const key = dirCacheKey(runtimeKey, directory);
  const candidates = [Math.min(sessions.length, SESSIONS_CAP), ...FALLBACK_LADDER];
  for (const cap of candidates) {
    try {
      const envelope: SessionsEnvelope = { version: 2, runtime: runtimeKey, directory, sessions: sessions.slice(0, cap) };
      store.setItem(key, JSON.stringify(envelope));
      return;
    } catch {
      /* quota/serialization failure: shrink and retry */
    }
  }
}

export function clearCachedSessions(directory: string): void {
  const store = storage();
  if (!store) return;
  store.removeItem(dirCacheKey(getRuntimeKey(), directory));
}

// ── lifecycle flush (pagehide/beforeunload/hidden/freeze) ───────────────────
let lifecycleInstalled = false;
export function installPersistLifecycleFlush(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  if (typeof window === 'undefined') return;
  const flushAll = (): void => {
    for (const [, write] of [...pendingWrites]) {
      clearTimeout(write.timer);
      pendingWrites.delete(dirCacheKey(write.runtimeKey, write.directory));
      // writes captured for a runtime that is no longer active are REJECTED
      if (write.runtimeKey !== getRuntimeKey()) continue;
      flushCachedSessions(write.directory, write.sessions, write.runtimeKey);
    }
  };
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('beforeunload', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  (window as unknown as { addEventListener: (kind: string, fn: () => void) => void }).addEventListener?.('freeze', flushAll);
}

// ── last-session pointer (per runtime, ≤8, confirm before opening) ──────────
const LAST_SESSION_KEY = 'nnd.lastSession.v1';
interface LastSessionEnvelope {
  version: 1;
  runtimes: Record<string, { sessionId: string; directory: string; updatedAt: number }>;
}

function readLastEnvelope(): LastSessionEnvelope {
  const store = storage();
  if (!store) return { version: 1, runtimes: {} };
  try {
    const parsed = JSON.parse(store.getItem(LAST_SESSION_KEY) ?? '') as LastSessionEnvelope;
    if (parsed.version !== 1 || typeof parsed.runtimes !== 'object') return { version: 1, runtimes: {} };
    return parsed;
  } catch {
    return { version: 1, runtimes: {} };
  }
}

export function persistLastActiveSession(sessionId: string | null, directory: string): void {
  const store = storage();
  if (!store) return;
  const envelope = readLastEnvelope();
  const runtimeKey = getRuntimeKey();
  if (sessionId) envelope.runtimes[runtimeKey] = { sessionId, directory, updatedAt: Date.now() };
  else delete envelope.runtimes[runtimeKey];
  const entries = Object.entries(envelope.runtimes);
  if (entries.length > 8) {
    const keep = entries.sort((a, b) => ((b[1] && b[1].updatedAt) || 0) - ((a[1] && a[1].updatedAt) || 0)).slice(0, 8);
    envelope.runtimes = Object.fromEntries(keep);
  }
  try {
    store.setItem(LAST_SESSION_KEY, JSON.stringify(envelope));
  } catch {
    /* convenience cache: dropping the write is fine */
  }
}

export function readLastActiveSession(): { sessionId: string; directory: string } | null {
  const entry = readLastEnvelope().runtimes[getRuntimeKey()];
  if (!entry) return null;
  return { sessionId: entry.sessionId, directory: entry.directory };
}

// ── runtime live-status seed (busy session survives a runtime switch) ───────
import type { SessionStatus } from '../lib/nnd/types.ts';
import { LIVE_STATUS_TTL_MS } from './types.ts';

const liveSeed = new Map<string, { status: SessionStatus; at: number; timer?: ReturnType<typeof setTimeout>; onExpire?: () => void }>();

export function seedLiveStatus(directory: string, sessionID: string, status: SessionStatus, onExpire?: () => void): void {
  const key = `${getRuntimeKey()}\n${directory}\n${sessionID}`;
  const previous = liveSeed.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: { status: SessionStatus; at: number; timer?: ReturnType<typeof setTimeout>; onExpire?: () => void } = {
    status,
    at: Date.now(),
    onExpire,
  };
  entry.timer = setTimeout(() => {
    if (liveSeed.get(key) !== entry) return;
    liveSeed.delete(key);
    entry.onExpire?.();
  }, LIVE_STATUS_TTL_MS);
  liveSeed.set(key, entry);
}

export function consumeLiveStatusSeed(directory: string, sessionID: string): SessionStatus | null {
  const key = `${getRuntimeKey()}\n${directory}\n${sessionID}`;
  const entry = liveSeed.get(key);
  if (!entry) return null;
  if (entry.status.type === 'idle') return null;
  const stale = Date.now() - entry.at > LIVE_STATUS_TTL_MS;
  if (stale) {
    liveSeed.delete(key);
    return null;
  }
  return entry.status;
}

export function clearLiveStatusSeeds(): void {
  for (const [, entry] of liveSeed) if (entry.timer) clearTimeout(entry.timer);
  liveSeed.clear();
}
