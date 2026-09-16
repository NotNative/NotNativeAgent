// SPDX-License-Identifier: Apache-2.0
/**
 * Directory bootstrap (doc 04 §C.3): seed from global + persisted snapshot,
 * phase-1 critical path (blocks first paint with chat data), then the
 * authoritative session list (phase 3, the scheduler slot holder). De-blocking
 * rule: abort ONLY when everything failed, or path failed AND no project.
 */
import type { StoreApi } from 'zustand/vanilla';
import { retry } from './bootstrap.ts';
import { harnessClient } from '../lib/nnd/client.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore, SyncState } from './types.ts';
import { GLOBAL_PAGE_SIZE } from './types.ts';
import { readCachedSessions } from './persist-cache.ts';
import { useGlobalSyncStore } from './global-stores.ts';
import { stripSessionListDetails } from './sanitize.ts';
import { runPhase2, emitSessionStatus } from './bootstrap-enrichment.ts';
import type { DirectoryBootstrapContext, DirectoryBootstrapOutcome } from './bootstrap-context.ts';

export async function bootstrapDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  isCurrent: () => boolean,
  ctx: DirectoryBootstrapContext,
): Promise<DirectoryBootstrapOutcome> {
  seedDirectoryFromGlobal(directory, store, ctx);
  const phase1 = await runPhase1(directory, store, isCurrent);
  if (!isCurrent()) return 'failed';
  if (!phase1.deblockingOk) return 'failed';
  const statusSnapshot = phase1.statusSnapshot as Record<string, SessionStatus> | null;
  store.setState({
    status: 'complete',
    ...(phase1.config ? { config: phase1.config as SyncState['config'] } : {}),
    ...(phase1.path ? { path: phase1.path as SyncState['path'] } : {}),
    ...(statusSnapshot
      ? { session_status: { ...store.getState().session_status, ...statusSnapshot }, sessionStatusReady: true }
      : {}), // a FAILED status snapshot must not grant idle authority
  });
  if (statusSnapshot) emitSessionStatus(statusSnapshot, directory);
  // deferred enrichment enqueued BEFORE the authoritative list fetch (never
  // extends the scheduler slot; gated on isCurrent inside)
  queueMicrotask(() => { void runPhase2(directory, store, isCurrent); });
  const listOk = await loadAuthoritativeSessions(directory, store, isCurrent, ctx);
  return listOk ? 'complete' : (store.getState().session.length > 0 ? 'complete' : 'failed');
}

type Phase1Result = { config: unknown; path: unknown; statusSnapshot: unknown; deblockingOk: boolean };

async function runPhase1(directory: string, store: StoreApi<DirectoryStore>, isCurrent: () => boolean): Promise<Phase1Result> {
  const [configResult, pathResult, statusResult] = await Promise.allSettled([
    retry(() => harnessClient.getConfig({ directory })),
    retry(() => harnessClient.getPath({ directory })),
    retry(() => harnessClient.sessionStatus({ directory })),
  ]);
  void isCurrent;
  const pick = (result: PromiseSettledResult<unknown>): unknown =>
    result.status === 'fulfilled' && result.value !== undefined ? result.value : null;
  const config = pick(configResult);
  const path = pick(pathResult);
  const statusSnapshot = pick(statusResult);
  return { config, path, statusSnapshot, deblockingOk: !(!config && !path && !statusSnapshot) };
}

function seedDirectoryFromGlobal(directory: string, store: StoreApi<DirectoryStore>, ctx: DirectoryBootstrapContext): void {
  const initial = store.getState();
  const loading = initial.status !== 'complete';
  const seededProject = ctx.activeProjectFor(directory);
  const cached = readCachedSessions(directory);
  const globalConfig = useGlobalSyncStore.getState().config;
  store.setState({
    ...(seededProject && !initial.project ? { project: seededProject } : {}),
    ...(globalConfig && !initial.config ? { config: globalConfig as SyncState['config'] } : {}),
    ...(cached && initial.session.length === 0 && initial.sessionListSource === 'empty'
      ? { session: cached, sessionListSource: 'persisted' as const }
      : {}),
    ...(loading ? { status: 'partial' as const } : {}),
  });
}

/** Phase 3: paged inclusive-of-nothing list (roots, then best-effort children). */
async function loadAuthoritativeSessions(
  directory: string,
  store: StoreApi<DirectoryStore>,
  isCurrent: () => boolean,
  ctx: DirectoryBootstrapContext,
): Promise<boolean> {
  let rootSessions: Session[] = [];
  let allSessions: Session[] | null = null;
  try {
    const roots = await retry(() => harnessClient.listSessions({ directory, roots: true, archived: false, limit: GLOBAL_PAGE_SIZE }));
    rootSessions = (roots ?? []).map((session) => stripSessionListDetails({ ...session }));
  } catch {
    return !isCurrent() ? false : store.getState().session.length > 0;
  }
  if (!isCurrent()) return false;
  try {
    const children = await retry(() => harnessClient.listSessions({ directory, roots: false, archived: false, limit: GLOBAL_PAGE_SIZE }));
    allSessions = (children ?? []).map((session) => stripSessionListDetails({ ...session }));
  } catch {
    allSessions = null; // best-effort second pass; roots-only fallback
  }
  if (!isCurrent()) return false;
  ctx.mergeBootstrap(directory, store, rootSessions, allSessions);
  // web/desktop: an EMPTY authoritative list is authoritative — no retry loop
  return true;
}
