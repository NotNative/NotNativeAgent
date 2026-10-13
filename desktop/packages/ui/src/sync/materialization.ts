// SPDX-License-Identifier: Apache-2.0
/**
 * Materialization helpers (doc 04 §D.8): renderability checks, stale running
 * tool detection, and snapshot merge semantics used by the scheduler.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { MessageEntry, Part } from '../lib/nnd/types.ts';
import type { DirectoryStore } from './types.ts';
import { normalizeMessageEntries } from './message-ordering.ts';
import { mergePartsPreservingTerminal } from './session-message-loader.ts';
import { sanitizeMessageEntry } from './sanitize.ts';

export function isSessionMaterializationStillNeeded(
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  request: { reason: string; messageID?: string },
): boolean {
  const state = store.getState();
  switch (request.reason) {
    case 'empty-assistant-message':
      // an EXPLICIT [] bucket counts: fetched-empty is authoritative
      return request.messageID ? state.part[request.messageID] === undefined : true;
    case 'missing-owning-message': {
      const messages = state.message[sessionID];
      if (!messages) return true;
      return request.messageID ? !messages.some((m) => m.id === request.messageID) : true;
    }
    case 'orphan-delta':
    case 'missing-delta-part':
      return request.messageID ? state.part[request.messageID] === undefined : true;
    case 'settled-running-tool': {
      const staleId = getStaleRunningToolMessageID(store, sessionID);
      return staleId !== null && (request.messageID ? staleId === request.messageID : true);
    }
    default:
      return true;
  }
}

/** Trailing assistant message whose newest tool part is still active when the
 * turn has settled (drives settled-running-tool refresh). */
export function getStaleRunningToolMessageID(store: StoreApi<DirectoryStore>, sessionID: string): string | null {
  const state = store.getState();
  const messages = state.message[sessionID];
  if (!messages || messages.length === 0) return null;
  const trailing = messages[messages.length - 1]!;
  if (trailing.role !== 'assistant' || trailing.time.completed === undefined) return null;
  const parts = state.part[trailing.id] ?? [];
  const stale = parts.some((part) => {
    const typed = part as { type?: string; state?: { status?: string } };
    return typed.type === 'tool' && (typed.state?.status === 'pending' || typed.state?.status === 'running');
  });
  return stale ? trailing.id : null;
}

/**
 * Merge authoritative snapshots into the store (scheduler path).
 * Terminal parts never regress; a pending/running tool under a COMPLETED
 * message finalizes to error/"Interrupted" (stale persisted tool state).
 */
export function materializeSessionSnapshots(store: StoreApi<DirectoryStore>, sessionID: string, records: MessageEntry[]): void {
  const entries = normalizeMessageEntries(records.map(sanitizeMessageEntry));
  if (entries.length === 0) return;
  const state = store.getState();
  const message = { ...state.message };
  const part = { ...state.part };
  const current = message[sessionID] ?? [];
  const next = [...current];

  for (const record of entries) {
    const index = next.findIndex((m) => m.id === record.info.id);
    let parts = record.parts;
    // completed message ⇒ finalize active tools (materialization.ts rule)
    if (record.info.role === 'assistant' && record.info.time.completed !== undefined) {
      parts = parts.map((p) => finalizeActiveTool(p));
    }
    if (index >= 0) {
      const existing = next[index]!;
      const existingParts = part[existing.id];
      const incomingComplete = parts.length > 0;
      if (existingParts !== undefined && !incomingComplete) {
        // server returned no parts for a materialized message: keep local parts
      } else {
        part[record.info.id] = mergePartsPreservingTerminal(existingParts, parts);
      }
      next[index] = existing.time.created === record.info.time.created && JSON.stringify(existing) === JSON.stringify(record.info)
        ? existing
        : record.info;
    } else {
      next.push(record.info);
      if (parts.length > 0) part[record.info.id] = parts;
      else part[record.info.id] = part[record.info.id] ?? [];
    }
  }
  next.sort((a, b) => (a.time.created - b.time.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  message[sessionID] = next;
  store.setState({ message, part });
}

function finalizeActiveTool(part: Part): Part {
  const typed = part as { type?: string; state?: { status?: string; error?: string; time?: { start?: number } } };
  if (typed.type !== 'tool' || !typed.state) return part;
  if (typed.state.status !== 'pending' && typed.state.status !== 'running') return part;
  return {
    ...part,
    state: {
      ...typed.state,
      status: 'error',
      error: 'Interrupted',
      time: { start: typed.state.time?.start ?? Date.now?.() ?? 0, end: Date.now?.() ?? 0 } as { start: number; end: number },
    },
  } as Part;
}
