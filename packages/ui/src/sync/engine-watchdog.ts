// SPDX-License-Identifier: Apache-2.0
/**
 * Watchdog (doc 04 §D.6): monotonic 5s status polls, escalation to a full
 * resync when a snapshot contradicts live busy state (15s cooldown), stale
 * stream detection (heartbeats count; 0 = disabled), and bounded child-session
 * discovery feeding parent materializations.
 */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore } from './types.ts';
import { ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS, ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS, CHILD_SESSION_DISCOVERY_INTERVAL_MS, STALE_STREAM_AFTER_MS } from './types.ts';
import type { ChildStoreManager } from './child-store.ts';
import { getReconnectCandidateIds } from './session-actions.ts';
import { useGlobalSessionStatusStore } from './global-stores.ts';
import { useSessionViewStore } from './view-store.ts';
import { areSessionStatusesEqual } from './event-equality.ts';

export interface WatchdogDeps {
  disposed: () => boolean;
  manager: ChildStoreManager;
  pipeline: () => { reconnect: (reason: string) => void; lastStreamActivityAt: () => number } | null;
  resyncDirectory: (directory: string, reason: string) => Promise<void>;
  enqueueMaterialization: (request: { reason: string; sessionID: string }, directory: string) => void;
}

interface WatchdogCtx {
  deps: WatchdogDeps;
  lastStatusPollAt: Map<string, number>;
  lastDiscoveryAt: Map<string, number>;
  escalateAt: number;
  streamResyncAt: number;
}

export function startWatchdog(deps: WatchdogDeps): () => void {
  const ctx: WatchdogCtx = { deps, lastStatusPollAt: new Map(), lastDiscoveryAt: new Map(), escalateAt: 0, streamResyncAt: 0 };
  const timer = setInterval(() => {
    if (deps.disposed()) return;
    void watchdogPass(ctx);
  }, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    ctx.lastStatusPollAt.clear();
    ctx.lastDiscoveryAt.clear();
  };
}

async function watchdogPass(ctx: WatchdogCtx): Promise<void> {
  const now = Date.now();
  for (const [directory, store] of [...ctx.deps.manager.children]) {
    if (directory === 'global') continue;
    const candidates = watchdogCandidates(store, directory);
    if (candidates.length === 0) continue;
    await watchStatusPoll(ctx, directory, store, candidates, now);
    await watchStaleStream(ctx, directory, now);
    await watchChildDiscovery(ctx, directory, store, candidates, now);
  }
  for (const directory of [...ctx.lastStatusPollAt.keys()]) {
    const store = ctx.deps.manager.children.get(directory);
    if (!store || watchdogCandidates(store, directory).length === 0) ctx.lastStatusPollAt.delete(directory);
  }
}

function watchdogCandidates(store: StoreApi<DirectoryStore>, directory: string): string[] {
  const view = useSessionViewStore.getState();
  const active = normalizeDirectory(view.activeDirectory);
  return getReconnectCandidateIds(store, view.currentSessionId, active, directory)
    .filter((id) => store.getState().session.some((session) => session.id === id));
}

async function watchStatusPoll(ctx: WatchdogCtx, directory: string, store: StoreApi<DirectoryStore>, candidates: string[], now: number): Promise<void> {
  void store;
  const recorded = ctx.lastStatusPollAt.get(directory);
  if (recorded !== undefined && now - recorded < ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS) return;
  ctx.lastStatusPollAt.set(directory, now);
  const result = await harnessClient.sessionStatus({ directory });
  if (ctx.deps.disposed() || result.error || !result.data) return; // failed poll must not clobber live state
  watchdogMonotonicApply(ctx, directory, result.data, candidates);
  watchEscalate(ctx, directory, store, result.data, candidates, now);
}

/** Monotonic: confirm/raise only, NEVER lowers a live entry (§D.6). */
function watchdogMonotonicApply(ctx: WatchdogCtx, directory: string, snapshot: Record<string, SessionStatus>, candidates: string[]): void {
  useGlobalSessionStatusStore.getState().applySnapshot(snapshot, candidates, 'monotonic');
  const store = ctx.deps.manager.children.get(directory);
  if (!store) return;
  const status = { ...store.getState().session_status };
  let changed = false;
  for (const sessionID of candidates) {
    const incoming = snapshot[sessionID];
    const current = status[sessionID];
    if (!incoming || incoming.type === 'idle') continue;
    if (current && current.type === 'idle') continue;
    if (!areSessionStatusesEqual(current, incoming)) {
      status[sessionID] = incoming;
      changed = true;
    }
  }
  if (changed) store.setState({ session_status: status });
}

function watchEscalate(
  ctx: WatchdogCtx,
  directory: string,
  store: StoreApi<DirectoryStore>,
  snapshot: Record<string, SessionStatus>,
  candidates: string[],
  now: number,
): void {
  const contradicted = candidates.some((sessionID) => {
    const current = store.getState().session_status[sessionID];
    const incoming = snapshot[sessionID];
    const believesActive = current && current.type !== 'idle';
    return Boolean(believesActive) && (!incoming || incoming.type === 'idle');
  });
  if (!contradicted) return;
  if (now - ctx.escalateAt < ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS) return;
  ctx.escalateAt = now;
  void ctx.deps.resyncDirectory(directory, 'stale-status-resync');
}

async function watchStaleStream(ctx: WatchdogCtx, directory: string, now: number): Promise<void> {
  const pipeline = ctx.deps.pipeline();
  if (!pipeline) return;
  const lastActivity = pipeline.lastStreamActivityAt();
  if (lastActivity === 0) return; // no traffic yet: check disabled
  if (now - lastActivity <= STALE_STREAM_AFTER_MS) return;
  if (now - ctx.streamResyncAt < ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS) return;
  ctx.streamResyncAt = now;
  pipeline.reconnect('active_stream_stale');
  void ctx.deps.resyncDirectory(directory, 'active_stream_stale');
}

async function watchChildDiscovery(
  ctx: WatchdogCtx,
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidates: string[],
  now: number,
): Promise<void> {
  const last = ctx.lastDiscoveryAt.get(directory);
  if (last !== undefined && now - last < CHILD_SESSION_DISCOVERY_INTERVAL_MS) return;
  ctx.lastDiscoveryAt.set(directory, now);
  const result = await harnessClient.listSessions({ directory, roots: false, archived: false, limit: 200 });
  if (ctx.deps.disposed() || ctx.deps.manager.children.get(directory) !== store || result.error || !result.data) return;
  const known = new Set(store.getState().session.map((session) => session.id));
  const candidateSet = new Set(candidates);
  for (const child of result.data as Session[]) {
    if (known.has(child.id)) continue;
    if (!child.parentID || !candidateSet.has(child.parentID)) continue;
    ctx.deps.enqueueMaterialization({ reason: 'child-session-discovered', sessionID: child.parentID }, directory);
    return; // one discovery materialization per pass is enough to open the subtree
  }
}
