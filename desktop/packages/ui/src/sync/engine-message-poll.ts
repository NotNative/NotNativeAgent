// SPDX-License-Identifier: Apache-2.0
/**
 * Delayed settle poll (doc 04 §D.7): a message that set time.completed while
 * the session may still be busy schedules ONE deferred status poll per
 * (directory, session) — monotonic, never clobbering live state.
 */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient } from '../lib/nnd/client.ts';
import type { DirectoryStore } from './types.ts';
import { MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS } from './types.ts';
import type { ChildStoreManager } from './child-store.ts';
import { useGlobalSessionStatusStore } from './global-stores.ts';
import { areSessionStatusesEqual } from './event-equality.ts';

export interface MessagePollDeps {
  disposed: () => boolean;
  manager: ChildStoreManager;
}

export function createMessageCompletionPoll(deps: MessagePollDeps) {
  const scheduled = new Map<string, { directory: string; sessionID: string; timer: ReturnType<typeof setTimeout> | null }>();

  const schedule = (directory: string, sessionID: string): void => {
    const key = `${directory}\n${sessionID}`;
    if (scheduled.has(key)) return; // one deferred poll per (directory, session)
    const entry = { directory, sessionID, timer: null as ReturnType<typeof setTimeout> | null };
    entry.timer = setTimeout(() => {
      scheduled.delete(key);
      void poll(entry.directory, entry.sessionID);
    }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS);
    scheduled.set(key, entry);
  };

  const poll = async (directory: string, sessionID: string): Promise<void> => {
    if (deps.disposed()) return;
    const store = deps.manager.children.get(directory);
    const status = store?.getState().session_status[sessionID];
    if (!store || !status || status.type === 'idle') return; // settled live in the meantime
    const result = await harnessClient.sessionStatus({ directory });
    if (deps.disposed() || result.error || !result.data) return;
    const incoming = result.data[sessionID];
    if (!incoming || incoming.type === 'idle') return; // monotonic poll never lowers a live busy
    const current = store.getState().session_status[sessionID];
    if (!current || current.type === 'idle') return;
    if (areSessionStatusesEqual(current, incoming)) return;
    const next = { ...store.getState().session_status, [sessionID]: incoming };
    store.setState({ session_status: next });
  };

  const reset = (): void => {
    for (const [, entry] of scheduled) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    scheduled.clear();
  };
  return { schedule, reset };
}
