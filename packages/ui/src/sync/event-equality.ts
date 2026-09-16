// SPDX-License-Identifier: Apache-2.0
/**
 * Reducer guard/equality helpers (doc 04 §B.2/§D.4). These keep store
 * references alive for no-op events — a returned `false` means NO field in
 * the draft may change.
 */
import type { Message, Part, Session, SessionStatus } from '../lib/nnd/types.ts';

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error', 'aborted', 'failed', 'timeout', 'cancelled']);

export function sessionRecency(session: Session): number {
  return Math.max(session.time.updated ?? 0, session.time.created ?? 0);
}

/** Freshness guard: incoming recency < current recency ⇒ skip (stale refresh). */
export function shouldSkipStaleSessionEvent(current: Session | undefined, incoming: Session): boolean {
  if (!current) return false;
  return sessionRecency(incoming) < sessionRecency(current);
}

export function areSessionStatusesEqual(a: SessionStatus | undefined, b: SessionStatus): boolean {
  if (!a) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'retry' && b.type === 'retry') {
    return a.attempt === b.attempt && a.message === b.message && a.next === b.next;
  }
  return true;
}

const MESSAGE_UPDATE_FIELDS = [
  'summary', 'error', 'cost', 'tokens', 'structured', 'model', 'tools', 'format', 'variant', 'agent', 'system',
] as const;

function loose(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export function areMessageUpdateFieldsEqual(current: Message, incoming: Message): boolean {
  if (current.role !== incoming.role) return false;
  const cur = loose(current);
  const inc = loose(incoming);
  if (loose(current.time).completed !== loose(incoming.time).completed) return false;
  if (cur['finish'] !== inc['finish']) return false;
  for (const field of MESSAGE_UPDATE_FIELDS) {
    if (field in cur || field in inc) {
      if (JSON.stringify(cur[field]) !== JSON.stringify(inc[field])) return false;
    }
  }
  return true;
}

/** Terminal-tool preservation (stale refresh shielding). */
export function shouldPreserveExistingPart(existing: Part | undefined, incoming: Part): boolean {
  if (!existing) return false;
  if (existing.type !== 'tool' || incoming.type !== 'tool') return false;
  const existingState = loose(existing)['state'] as Record<string, unknown> | undefined;
  const incomingState = loose(incoming)['state'] as Record<string, unknown> | undefined;
  const existingTerminal = Boolean(existingState && TERMINAL_TOOL_STATUSES.has(String(existingState['status'])));
  const existingEnd = Boolean(existingState && loose(existingState['time']).end !== undefined);
  if (!existingTerminal && !existingEnd) return false;
  const incomingTerminal = Boolean(incomingState && TERMINAL_TOOL_STATUSES.has(String(incomingState['status'])));
  const incomingEnd = Boolean(incomingState && loose(incomingState['time']).end !== undefined);
  return !incomingTerminal && !incomingEnd;
}

/** Snapshot-after-delta dedupe: which fields relate between snapshots. */
export function getUpdatedDeltaFields(previous: Part | undefined, incoming: Part): string[] {
  if (!previous) return [];
  const fields: string[] = [];
  const prev = loose(previous);
  const next = loose(incoming);
  const prevState = prev['state'] as Record<string, unknown> | undefined;
  const nextState = next['state'] as Record<string, unknown> | undefined;
  if (typeof prev['text'] === 'string' && typeof next['text'] === 'string' && prev['text'] !== next['text']) {
    if (next['text']!.startsWith(prev['text']!) || prev['text']!.startsWith(next['text']!)) fields.push('text');
  }
  const prevOutput = prevState ? prevState['output'] : undefined;
  const nextOutput = nextState ? nextState['output'] : undefined;
  if (typeof prevOutput === 'string' && typeof nextOutput === 'string' && prevOutput !== nextOutput) {
    if (nextOutput.startsWith(prevOutput) || prevOutput.startsWith(nextOutput)) fields.push('output');
  }
  return fields;
}

/** Longest suffix-overlap append: when the incoming chunk repeats text the
 * store already ends with, merge on the overlap instead of duplicating. */
export function appendNonOverlappingDelta(current: string, delta: string): string {
  if (!current) return delta;
  if (!delta) return current;
  const max = Math.min(current.length, delta.length);
  for (let size = max; size > 0; size -= 1) {
    if (current.endsWith(delta.slice(0, size))) return current + delta.slice(size);
  }
  return current + delta;
}

export function binarySearchIndex(sorted: { id: string }[], id: string): { found: boolean; index: number } {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = sorted[mid]!.id;
    if (value === id) return { found: true, index: mid };
    if (value < id) low = mid + 1;
    else high = mid - 1;
  }
  return { found: false, index: low };
}

export function upsertById<T extends { id: string }>(sorted: T[], item: T): { inserted: boolean } {
  const { found, index } = binarySearchIndex(sorted, item.id);
  if (found) {
    if (sorted[index] === item) return { inserted: false };
    sorted[index] = item;
    return { inserted: false };
  }
  sorted.splice(index, 0, item);
  return { inserted: true };
}

export function removeById<T extends { id: string }>(sorted: T[], id: string): boolean {
  const { found, index } = binarySearchIndex(sorted, id);
  if (!found) return false;
  sorted.splice(index, 1);
  return true;
}
