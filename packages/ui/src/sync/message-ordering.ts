// SPDX-License-Identifier: Apache-2.0
/**
 * Chronology helpers (doc 04 §A.6): IDs are identity, NEVER chronology.
 * Everything orders by (time.created, id). Arrays handed to the in-place
 * helpers must already be batch-cloned slices.
 */
import type { Message, MessageEntry } from '../lib/nnd/types.ts';

export function compareMessagesChronological(a: { time: { created: number }; id: string }, b: { time: { created: number }; id: string }): number {
  if (a.time.created !== b.time.created) return a.time.created - b.time.created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortMessagesChronological<T extends { time: { created: number }; id: string }>(messages: T[]): T[] {
  return [...messages].sort(compareMessagesChronological);
}

/** Binary insert into an already-clone, already-sorted array; mutates it. */
export function insertMessageChronological<T extends { time: { created: number }; id: string }>(sorted: T[], message: T): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareMessagesChronological(sorted[mid]!, message) <= 0) low = mid + 1;
    else high = mid;
  }
  sorted.splice(low, 0, message);
}

export function removeMessageById<T extends { id: string }>(messages: T[], messageID: string): T | undefined {
  const index = messages.findIndex((m) => m.id === messageID);
  if (index < 0) return undefined;
  return messages.splice(index, 1)[0];
}

/** Entries sorted for store/merge use (doc 04 §E.1 HTTP page shape). */
export function normalizeMessageEntries(entries: MessageEntry[]): MessageEntry[] {
  return [...entries]
    .filter((entry) => Boolean(entry) && Boolean(entry.info) && Array.isArray(entry.parts))
    .sort((a, b) => compareMessagesChronological(a.info, b.info));
}

/** Revert projection: visible timeline = everything BEFORE (and excluding)
 * the revert marker. Records stay in the store (restore keeps the data). */
export function messagesBefore(messages: Message[], revertMessageID: string | undefined): Message[] {
  if (!revertMessageID) return messages;
  const index = messages.findIndex((m) => m.id === revertMessageID);
  if (index < 0) return messages;
  return messages.slice(0, index);
}

/** Truncate a store message array at the revert target (optimistic revert
 * commit, doc 04 §E.2 step 5); mutates the cloned array. */
export function truncateAtMessageId(messages: Message[], messageID: string): void {
  const index = messages.findIndex((m) => m.id === messageID);
  if (index >= 0) messages.length = index;
}
