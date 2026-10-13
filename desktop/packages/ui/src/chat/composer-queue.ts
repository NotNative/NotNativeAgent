// SPDX-License-Identifier: Apache-2.0
/**
 * Composer queue target (doc 12 §D.7, SLICE-C task 4): a send pressed while
 * busy/blocked routes into the SERVER-owned queue for open sessions
 * (optimistic add, restore-to-composer on failure, input history recorded
 * only on server acceptance); draft columns keep the client-held queue.
 */
import { toast } from 'sonner';
import { useMessageQueueStore } from '../stores/useMessageQueueStore.ts';
import type { QueuedSendConfig } from '../stores/useMessageQueueStore.ts';
import type { QueuedMessage } from './drafts.ts';

export interface QueueTargetArgs {
  directory: string;
  sessionID: string | null;
  sessionKey: string;
  composed: string;
  liveQueue: QueuedMessage[];
  setQueueChips: (chips: QueuedMessage[]) => void;
  saveDraftQueue: (queue: QueuedMessage[]) => void;
  clearComposer: () => void;
  restoreComposer: () => void;
  sendConfig: QueuedSendConfig;
  recordHistory: () => void;
}

export async function handleQueuedTarget(args: QueueTargetArgs): Promise<void> {
  if (args.sessionID === null) {
    // §D.9 draft columns ride the client-held queue (server has no target).
    const queued = localQueued(args);
    args.setQueueChips([...args.liveQueue, queued]);
    args.saveDraftQueue([...args.liveQueue, queued]);
    args.clearComposer();
    toast.message('Message queued behind the running draft column');
    return;
  }
  const result = await useMessageQueueStore.getState().addToQueue(args.directory, args.sessionID, {
    content: args.composed,
    sendConfig: args.sendConfig,
  });
  if (!result.ok) {
    toast.error(`Failed to queue the message — it stays in the composer (${result.error ?? 'unknown'})`);
    args.restoreComposer();
    return;
  }
  args.recordHistory();
  args.clearComposer();
  toast.message('Message queued — the server delivers it when the session goes idle');
}

function localQueued(args: QueueTargetArgs): QueuedMessage {
  return {
    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: args.composed,
    mentions: [],
    attachments: [],
    queuedAt: Date.now(),
  };
}
