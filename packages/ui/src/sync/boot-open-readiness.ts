// SPDX-License-Identifier: Apache-2.0
/**
 * SLICE-A chat-alive boot-open readiness (doc 05 §A). The boot-open decision
 * needs the AUTHORITATIVE SESSION LIST (§C.3 step 7d): bootstrapDirectory sets
 * `status: 'complete'` BEFORE its phase-3 list merge, and the recovery
 * 'initial' resync short-circuits on a fresh boot (zero reconnect
 * candidates) — so neither signal alone proves the list has landed. This
 * waiter resolves when `sessionListSource` becomes 'authoritative', when the
 * bootstrap fails outright, or at the cap. After it resolves, the engine
 * falls through to the plain decision; the empty draft stays an honest state.
 */
import { normalizeDirectory } from '../lib/nnd/client.ts';
import type { StoreApi } from 'zustand/vanilla';

/** Minimal child-store shape this waiter needs (keeps the seams small). */
export interface BootListStore {
  getState(): { status: string; sessionListSource: string };
  subscribe(listener: () => void): () => void;
}

export interface BootListManager {
  peekChild(directory: string): BootListStore | undefined;
}

export async function awaitAuthoritativeList(
  manager: BootListManager,
  directory: string,
  timeoutMs: number,
): Promise<void> {
  const store = manager.peekChild(normalizeDirectory(directory));
  if (!store) return;
  const ready = (): boolean => {
    const state = store.getState();
    return state.sessionListSource === 'authoritative';
  };
  const failed = (): boolean => store.getState().status === 'failed';
  if (ready() || failed()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (ready() || failed()) finish();
    });
    if (ready() || failed()) finish(); // landed between call and subscribe
  });
}
