// SPDX-License-Identifier: Apache-2.0
/**
 * Materialization scheduler (doc 04 §D.8): cooldown-guarded refetch of missing
 * transcript slices. Key [runtime, directory, session]; runs after the current
 * batch; pre-flight re-check; refreshTail(30); pre-refresh status resync when
 * not idle; then interrupted-turn recovery + streaming reconciliation.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore, MaterializationRequest } from './types.ts';
import { SESSION_MATERIALIZATION_COOLDOWN_MS, SESSION_MATERIALIZATION_MESSAGE_LIMIT } from './types.ts';
import { isSessionMaterializationStillNeeded } from './materialization.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { GLOBAL_DIRECTORY } from './routing-index.ts';

interface Entry {
  request: MaterializationRequest;
  directory: string;
}

export interface MaterializationDeps {
  disposed: () => boolean;
  storeOf: (directory: string) => StoreApi<DirectoryStore> | undefined;
  /** authoritative status resync for specific sessions of one directory */
  statusResync: (directory: string, sessionIDs: string[]) => Promise<void>;
  /** loader refreshTail bound to a live store (tail never clobbers cursor) */
  refreshTail: (store: StoreApi<DirectoryStore>, directory: string, sessionID: string, limit: number) => Promise<void>;
  /** post-load hook: interrupted-turn recovery + streaming reconciliation */
  afterLoad: (store: StoreApi<DirectoryStore>, sessionID: string) => void;
}

export function createMaterializationScheduler(deps: MaterializationDeps) {
  const pending = new Map<string, Entry>();
  const lastRunAt = new Map<string, number>();

  const enqueue = (request: MaterializationRequest, directory: string): void => {
    if (deps.disposed() || !request.sessionID || directory === GLOBAL_DIRECTORY) return;
    const key = matKey(directory, request.sessionID);
    if (withinCooldown(key) && request.reason !== 'settled-running-tool') return; // dedup incl. fast success
    // settled-running-tool may supersede a different pending reason
    pending.set(key, { request, directory });
    queueMicrotask(() => { void run(key); });
  };

  const withinCooldown = (key: string): boolean => {
    const at = lastRunAt.get(key);
    return at !== undefined && Date.now() - at < SESSION_MATERIALIZATION_COOLDOWN_MS;
  };

  const run = async (key: string): Promise<void> => {
    const entry = pending.get(key);
    if (!entry || deps.disposed()) return;
    pending.delete(key); // one attempt per enqueue batch; cooldown lives in lastRunAt
    const store = deps.storeOf(entry.directory);
    if (!store) return;
    const { request } = entry;
    if (!isSessionMaterializationStillNeeded(store, request.sessionID, request)) return;
    lastRunAt.set(key, Date.now());
    const status = store.getState().session_status[request.sessionID];
    if (status && status.type !== 'idle') {
      await deps.statusResync(entry.directory, [request.sessionID]);
      if (deps.disposed() || deps.storeOf(entry.directory) !== store) return;
    }
    await deps.refreshTail(store, entry.directory, request.sessionID, SESSION_MATERIALIZATION_MESSAGE_LIMIT);
    if (deps.disposed() || deps.storeOf(entry.directory) !== store) return;
    deps.afterLoad(store, request.sessionID);
  };

  const stats = (): { pending: number; lastRunAtMs: Map<string, number> } => ({ pending: pending.size, lastRunAtMs: new Map(lastRunAt) });
  const reset = (): void => {
    pending.clear();
    lastRunAt.clear();
  };
  return { enqueue, stats, reset };
}

function matKey(directory: string, sessionID: string): string {
  return `${getRuntimeKey()}\n${directory}\n${sessionID}`;
}
