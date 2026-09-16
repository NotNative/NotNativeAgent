// SPDX-License-Identifier: Apache-2.0
/**
 * Reducer core (doc 04 §B.2/§B.3): the BatchOutcome shape + reduction API
 * shared by the layered event reducers (session / transcript / blocking).
 * Invariant: a batch clones each touched field at most once and commits one
 * setState per store per flush; no-op events must change zero references.
 */
import type {
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  Todo,
} from '../lib/nnd/types.ts';
import type { MaterializationRequest, SyncState } from './types.ts';

export const SKIP_PART_TYPES = new Set(['patch', 'step-start', 'step-finish']);

export function loose(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export interface ReducerApi {
  /** clone-on-first-write for the named state field (§B.3 golden rule) */
  ensure: (field: keyof SyncState) => void;
  changed: () => void;
  out: BatchOutcome;
  now: number;
}

export interface BatchOutcome {
  /** number of events that changed the draft */
  changedCount: number;
  materializations: MaterializationRequest[];
  /** sessions whose caches (message/part/todo/diff/status/permission/question) were dropped */
  cleanupSessionIds: string[];
  /** routing-index ingest hints */
  sessionRoutes: { sessionID: string; directory: string }[];
  messageRoutes: { messageID: string; sessionID: string }[];
  /** sidecar signals */
  statusChanges: { sessionID: string; status: SessionStatus }[];
  settled: { sessionID: string; kind: 'idle' | 'error'; error?: unknown }[];
  permissionAsks: { sessionID: string; request: PermissionRequest }[];
  permissionReplies: { sessionID: string; requestID: string }[];
  questionAsks: { sessionID: string; request: QuestionRequest }[];
  questionSettled: { sessionID: string; requestID: string }[];
  todosPersisted: { sessionID: string; todos: Todo[] }[];
  sessionRemoved: string[];
  /** archive: the record (stripped) rides OUT so side effects can republish it
   * to the global cache's archived bucket — the reducer has already removed it. */
  sessionArchived: { sessionID: string; record: import('../lib/nnd/types.ts').Session | null }[];
  /** message set time.completed while its session may still be busy (750ms poll, §D.7) */
  messageCompleted: { sessionID: string; messageID: string }[];
  projectUpdated: unknown | null;
  globalRefresh: boolean;
  lspRefresh: boolean;
  partChangedMessageIDs: string[];
}

export function emptyOutcome(): BatchOutcome {
  return {
    changedCount: 0,
    materializations: [],
    cleanupSessionIds: [],
    sessionRoutes: [],
    messageRoutes: [],
    statusChanges: [],
    settled: [],
    permissionAsks: [],
    permissionReplies: [],
    questionAsks: [],
    questionSettled: [],
    todosPersisted: [],
    sessionRemoved: [],
    sessionArchived: [],
    messageCompleted: [],
    projectUpdated: null,
    globalRefresh: false,
    lspRefresh: false,
    partChangedMessageIDs: [],
  };
}

export function notePartChanged(out: BatchOutcome, messageID: string): void {
  if (!out.partChangedMessageIDs.includes(messageID)) out.partChangedMessageIDs.push(messageID);
}
