// SPDX-License-Identifier: Apache-2.0
/**
 * Reconnect recovery (doc 04 §D.5): candidate enumeration, authoritative
 * status resync (absence ⇒ explicit idle), per-candidate session.get +
 * refreshTail(30), interrupted-turn recovery, and the signature-guarded
 * blocking-request resync. All publication is stale-guarded against runtime,
 * store identity, and manager generation.
 */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore } from './types.ts';
import { RECONNECT_MESSAGE_LIMIT } from './types.ts';
import type { ChildStoreManager } from './child-store.ts';
import type { SessionMessageLoader, LoaderTarget } from './session-message-loader.ts';
import type { EventRoutingIndex } from './routing-index.ts';
import { registerSessionDirectory } from './routing-index.ts';
import { getReconnectCandidateIds } from './session-actions.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from './global-stores.ts';
import { useSessionOrderingStore } from './session-ordering.ts';
import { useSessionViewStore } from './view-store.ts';
import { resyncBlockingKind } from './bootstrap-enrichment.ts';
import { isNnaActivitySource, refreshActivitySnapshot } from './activity-snapshot.ts';
import { shouldSkipStaleSessionEvent } from './event-equality.ts';
import { adoptSessionProjection } from './nna-projection.ts';
import { loadAuthoritativeSessions } from './bootstrap-directory.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

export interface RecoveryDeps {
  disposed: () => boolean;
  manager: ChildStoreManager;
  loader: SessionMessageLoader;
  routing: EventRoutingIndex;
  afterMessageLoad: (store: StoreApi<DirectoryStore>, sessionID: string) => void;
  beginCatalog: (directory: string) => (dir: string, store: StoreApi<DirectoryStore>, roots: Session[], children: Session[] | null, baselineRevision: number) => void;
}

interface RecoveryCtx {
  deps: RecoveryDeps;
  resyncingDirs: Set<string>;
  inflight: Map<string, Promise<void>>;
  lastFullResyncAt: Map<string, number>;
}

export function createRecovery(deps: RecoveryDeps) {
  const ctx: RecoveryCtx = { deps, resyncingDirs: new Set<string>(), inflight: new Map<string, Promise<void>>(), lastFullResyncAt: new Map<string, number>() };
  return {
    resyncDirectory: (directory: string, reason: string): Promise<void> => recoveryResyncDirectory(ctx, directory, reason, false),
    authoritativeStatusResync: async (directory: string, candidates: string[]): Promise<void> => {
      await recoveryStatusResync(ctx, directory, candidates);
    },
    resyncAfterStreamGap: (reason: string): Promise<void> => recoveryAfterStreamGap(ctx, reason),
    recoverAuthorityGap: (reason: string): Promise<boolean> => recoveryAuthorityGap(ctx, reason),
    stats: (): { resyncing: string[]; lastResyncAt: Map<string, number> } => ({
      resyncing: [...ctx.resyncingDirs],
      lastResyncAt: new Map(ctx.lastFullResyncAt),
    }),
    forget: (directory: string): void => {
      ctx.resyncingDirs.delete(directory);
      ctx.inflight.delete(directory);
      ctx.lastFullResyncAt.delete(directory);
    },
    reset: (): void => {
      ctx.resyncingDirs.clear();
      ctx.inflight.clear();
      ctx.lastFullResyncAt.clear();
    },
  };
}

/** §D.5 full recovery for one directory. Deduped per directory. */
async function recoveryResyncDirectory(ctx: RecoveryCtx, directory: string, reason: string, fullCatalog: boolean): Promise<void> {
  void reason;
  if (ctx.deps.disposed()) return;
  const runtime = getRuntimeKey();
  if (ctx.resyncingDirs.has(directory)) {
    // A watchdog candidate pass must not consume a reconnect's full-catalog
    // request. Let it finish, then perform the authoritative read.
    if (fullCatalog) {
      await ctx.inflight.get(directory)?.catch(() => undefined);
      if (!ctx.deps.disposed() && getRuntimeKey() === runtime) await recoveryResyncDirectory(ctx, directory, reason, true);
    }
    return;
  }
  ctx.resyncingDirs.add(directory);
  ctx.lastFullResyncAt.set(directory, Date.now());
  const task = recoveryResyncBody(ctx, directory, fullCatalog);
  ctx.inflight.set(directory, task);
  try {
    await task;
  } finally {
    if (ctx.inflight.get(directory) === task) {
      ctx.resyncingDirs.delete(directory);
      ctx.inflight.delete(directory);
    }
  }
}

async function recoveryResyncBody(ctx: RecoveryCtx, directory: string, fullCatalog: boolean): Promise<void> {
  const store = ctx.deps.manager.children.get(directory);
  if (!store) return;
  if (fullCatalog) {
    const runtime = getRuntimeKey();
    const mergeCatalog = ctx.deps.beginCatalog(directory);
    await loadAuthoritativeSessions(directory, store, () => isStable(ctx, directory, store)() && getRuntimeKey() === runtime, {
      activeProjectFor: () => null,
      mergeBootstrap: mergeCatalog,
    }, true);
  }
  if (!isStable(ctx, directory, store)()) return;
  const view = useSessionViewStore.getState();
  const candidates = getReconnectCandidateIds(store, view.currentSessionId, normalizeDirectory(view.activeDirectory), directory);
  if (candidates.length === 0) return;
  await recoveryStatusResync(ctx, directory, candidates);
  if (ctx.deps.disposed() || ctx.deps.manager.children.get(directory) !== store) return;
  await recoveryCandidates(ctx, directory, store, candidates);
  if (ctx.deps.disposed() || ctx.deps.manager.children.get(directory) !== store) return;
  await Promise.allSettled([
    resyncBlockingKind(store, directory, 'question', isStable(ctx, directory, store)),
    resyncBlockingKind(store, directory, 'permission', isStable(ctx, directory, store)),
  ]);
}

function isStable(ctx: RecoveryCtx, directory: string, store: StoreApi<DirectoryStore>): () => boolean {
  return () => !ctx.deps.disposed() && ctx.deps.manager.children.get(directory) === store;
}

/** §D.5 authoritative status resync: snapshot replaces candidates; absence ⇒ idle. */
async function recoveryStatusResync(ctx: RecoveryCtx, directory: string, candidates: string[]): Promise<boolean> {
  if (candidates.length === 0) return true;
  const store = ctx.deps.manager.children.get(directory);
  const result = await harnessClient.sessionStatus({ directory });
  if (ctx.deps.disposed() || result.error || !result.data) return false; // null preserves state, never empty success
  if (!store || ctx.deps.manager.children.get(directory) !== store) return false;
  useGlobalSessionStatusStore.getState().applySnapshot(result.data, candidates, 'authoritative');
  useSessionOrderingStore.getState().reconcileSnapshot(entriesSnapshot(result.data, candidates));
  const nextStatus = { ...store.getState().session_status };
  for (const sessionID of candidates) {
    nextStatus[sessionID] = result.data[sessionID] ?? ({ type: 'idle' } as SessionStatus);
  }
  store.setState({ session_status: nextStatus, sessionStatusReady: true });
  for (const sessionID of candidates) {
    if (!result.data[sessionID] || result.data[sessionID]!.type === 'idle') {
      ctx.deps.afterMessageLoad(store, sessionID);
    }
  }
  return true;
}

async function recoveryCandidates(ctx: RecoveryCtx, directory: string, store: StoreApi<DirectoryStore>, candidates: string[]): Promise<void> {
  await Promise.allSettled(candidates.map(async (sessionID) => {
    const requestRevision = store.getState().sessionRevision;
    const fetched = await harnessClient.getSession(sessionID, { directory });
    if (ctx.deps.disposed() || fetched.error || !fetched.data || fetched.data.id !== sessionID
      || ctx.deps.manager.children.get(directory) !== store) return;
    upsertFetchedSession(store, fetched.data, requestRevision);
    // A live deletion may have won the race. Do not re-register its route or
    // materialize a transcript after the catalog record was removed.
    if (!store.getState().session.some((entry) => entry.id === sessionID)) return;
    registerSessionDirectory(ctx.deps.routing, sessionID, directory);
    await ctx.deps.loader.refreshTail({ directory, sessionID, store } as LoaderTarget, RECONNECT_MESSAGE_LIMIT);
    if (isNnaActivitySource(store)) {
      await refreshActivitySnapshot(store, directory, sessionID, isStable(ctx, directory, store));
    }
    ctx.deps.afterMessageLoad(store, sessionID);
  }));
}

/** §D.5 gap catch-up across EVERY child directory, TWO at a time. */
async function recoveryAfterStreamGap(ctx: RecoveryCtx, reason: string): Promise<void> {
  if (ctx.deps.disposed()) return;
  const runtime = getRuntimeKey();
  const dirs = [...ctx.deps.manager.children.keys()].filter((dir) => dir !== 'global');
  for (let index = 0; index < dirs.length; index += 2) {
    const batch = dirs.slice(index, index + 2);
    await Promise.allSettled(batch.map((dir) => recoveryResyncDirectory(ctx, dir, reason, true)));
    if (ctx.deps.disposed() || getRuntimeKey() !== runtime) return;
  }
  // The sidebar has its own inclusive (active + archived) catalog. Refresh it
  // after child merges so older child upserts cannot reintroduce deletions.
  if (!ctx.deps.disposed() && getRuntimeKey() === runtime) {
    await useGlobalSessionsStore.getState().loadSessions();
    if (ctx.deps.disposed() || getRuntimeKey() !== runtime) return;
    const catalog = useGlobalSessionsStore.getState();
    const selected = useSessionViewStore.getState().currentSessionId;
    // An offline deletion has no event to retire the view pointer. Wait for
    // the inclusive native read so an archived session is not mistaken for it.
    if (catalog.status === 'ready' && selected
      && !catalog.active.some(session => session.id === selected)
      && !catalog.archived.some(session => session.id === selected)) {
      useSessionViewStore.getState().setCurrentSession(null);
    }
  }
}

/** A native authority gap needs a complete catalog, not the ordinary
 * best-effort reconnect path that intentionally preserves stale snapshots. */
async function recoveryAuthorityGap(ctx: RecoveryCtx, reason: string): Promise<boolean> {
  if (ctx.deps.disposed()) return false;
  const runtime = getRuntimeKey();
  const dirs = [...ctx.deps.manager.children.keys()].filter((dir) => dir !== 'global');
  for (let index = 0; index < dirs.length; index += 2) {
    const batch = dirs.slice(index, index + 2);
    const results = await Promise.all(batch.map(async (dir) => {
      const store = ctx.deps.manager.children.get(dir);
      if (!store) return false;
      const complete = await loadAuthoritativeSessions(dir, store,
        () => !ctx.deps.disposed() && getRuntimeKey() === runtime && ctx.deps.manager.children.get(dir) === store,
        { activeProjectFor: () => null, mergeBootstrap: ctx.deps.beginCatalog(dir) }, true);
      if (!complete) return false;
      await recoveryResyncDirectory(ctx, dir, reason, false);
      if (ctx.deps.disposed() || getRuntimeKey() !== runtime || ctx.deps.manager.children.get(dir) !== store) return false;
      // Best-effort reconnect reads can preserve stale status or blocking cards
      // on failure. A native authority gap requires explicit successful reads.
      const view = useSessionViewStore.getState();
      const candidates = getReconnectCandidateIds(store, view.currentSessionId,
        normalizeDirectory(view.activeDirectory), dir);
      if (!await recoveryStatusResync(ctx, dir, candidates)) return false;
      const stable = () => !ctx.deps.disposed() && getRuntimeKey() === runtime
        && ctx.deps.manager.children.get(dir) === store;
      const [questions, permissions] = await Promise.all([
        resyncBlockingKind(store, dir, 'question', stable),
        resyncBlockingKind(store, dir, 'permission', stable),
      ]);
      return questions && permissions && stable();
    }));
    if (results.some((ok) => !ok) || ctx.deps.disposed() || getRuntimeKey() !== runtime) return false;
  }
  await useGlobalSessionsStore.getState().loadSessions();
  return !ctx.deps.disposed() && getRuntimeKey() === runtime && useGlobalSessionsStore.getState().status === 'ready';
}

function entriesSnapshot(snapshot: Record<string, SessionStatus>, candidates: string[]): { sessionID: string; status: SessionStatus }[] {
  return candidates.map((sessionID) => ({
    sessionID,
    status: snapshot[sessionID] ?? ({ type: 'idle' } as SessionStatus),
  }));
}

function upsertFetchedSession(store: StoreApi<DirectoryStore>, record: Session, requestRevision: number): void {
  store.setState((state) => {
    const session = reconcileFetchedSession(state, record, requestRevision);
    return session === state.session ? state : { session };
  });
}

/** A GET is authoritative only if it is not older than a live event already
 * applied to this store. Replace the full description so removed projections
 * cannot survive as stale metadata after a correction or restart. */
export function reconcileFetchedSession(
  state: Pick<DirectoryStore, 'session' | 'sessionEventRevision' | 'sessionDeletedRevision'>,
  record: Session,
  requestRevision: number,
): Session[] {
  const sessions = state.session;
  // A live upsert or deletion after this request began wins even when both
  // descriptions share a timestamp. An earlier tombstone cannot be revived
  // by a delayed GET for a candidate that was already removed.
  if ((state.sessionEventRevision[record.id] ?? 0) > requestRevision) return sessions;
  if ((state.sessionDeletedRevision[record.id] ?? 0) > 0 && !sessions.some((entry) => entry.id === record.id)) return sessions;
  const index = sessions.findIndex((existing) => existing.id === record.id);
  if (index < 0) return [...sessions, record].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (shouldSkipStaleSessionEvent(sessions[index], record)) return sessions;
  const next = [...sessions];
  next[index] = adoptSessionProjection(sessions[index], record);
  return next;
}
