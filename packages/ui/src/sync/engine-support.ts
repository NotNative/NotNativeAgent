// SPDX-License-Identifier: Apache-2.0
/**
 * Engine support helpers (doc 04 §D.5-D.8): streaming reconciliation, live
 * timing entry, post-load interrupted-turn recovery, and the harness default
 * directory probe. Pure over the stores they read.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore, SyncState } from './types.ts';
import type { ReducerApi } from './reducer-core.ts';
import { emptyOutcome } from './reducer-core.ts';
import { finalizeInterruptedTurn } from './event-reducer.ts';
import { useStreamingStore, settleFromCoveredSnapshot, markLiveStart, getStartedAt } from './activity-streaming.ts';
import { GLOBAL_DIRECTORY } from './routing-index.ts';
import { harnessClient, getHarnessDirectory } from '../lib/nnd/client.ts';

/** Publishing reconciliation for the streaming sidecar (§H.1). */
export function reconcileStreaming(sessionID: string, store: StoreApi<DirectoryStore>): void {
  const state = store.getState();
  const busy = state.session_status[sessionID]?.type === 'busy' || state.session_status[sessionID]?.type === 'retry';
  const messages = state.message[sessionID] ?? [];
  const trailing = messages[messages.length - 1];
  const trailingAssistant = trailing && trailing.role === 'assistant'
    ? { id: trailing.id, completed: trailing.time.completed !== undefined }
    : null;
  useStreamingStore.getState().reconcile({ sessionID, busy, trailingAssistant });
}

/** Live coverage of THIS page: mark a start on first busy observation. */
export function ensureLiveTiming(sessionID: string): void {
  if (getStartedAt(sessionID) !== undefined) return;
  markLiveStart(sessionID);
}

/**
 * Post-load interrupted-turn recovery (§D.7): finalize ONLY on an explicit
 * authoritative settle, never absent status, never busy, and not while a
 * blocking request is pending. Commits directly to the store on change.
 */
export function recoverInterruptedTurnAfterMessageLoad(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const before = store.getState();
  const status = before.session_status[sessionID];
  if (!status || status.type !== 'idle') return; // only explicit settles finally
  const commit = interruptedTurnCommit(before);
  finalizeInterruptedTurn(commit.draft, sessionID, commit.api, Date.now());
  const patch = commit.publish();
  if (patch) store.setState(patch);
}

function interruptedTurnCommit(before: SyncState): { draft: SyncState; api: ReducerApi; publish: () => Partial<SyncState> | null } {
  const draft: SyncState = { ...before };
  const cloned = new Set<keyof SyncState>();
  const ensure = (field: keyof SyncState): void => {
    if (cloned.has(field)) return;
    cloned.add(field);
    const value = draft[field];
    if (Array.isArray(value)) {
      (draft as unknown as Record<string, unknown>)[field as string] = [...(value as unknown[])];
    } else if (value && typeof value === 'object') {
      (draft as unknown as Record<string, unknown>)[field as string] = { ...(value as object) };
    }
  };
  const api: ReducerApi = { ensure, changed: () => undefined, out: emptyOutcome(), now: Date.now() };
  return {
    draft,
    api,
    publish: () => {
      if (cloned.size === 0) return null;
      const patch: Partial<SyncState> = {};
      for (const field of cloned) (patch as Record<string, unknown>)[field as string] = draft[field];
      return patch;
    },
  };
}

/** §C.4: current harness directory (workspace root when the path is unknown). */
export async function defaultHarnessDirectory(): Promise<string> {
  const current = getHarnessDirectory();
  if (current && current !== GLOBAL_DIRECTORY) return current;
  const pathResult = await harnessClient.getPath();
  const loosePath = pathResult.data as Record<string, unknown> | undefined;
  const candidate = typeof loosePath?.['directory'] === 'string' ? loosePath['directory'] as string : '';
  return candidate ? candidate : GLOBAL_DIRECTORY;
}

export { settleFromCoveredSnapshot, useStreamingStore };
