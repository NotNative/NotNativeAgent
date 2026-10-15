// SPDX-License-Identifier: Apache-2.0
/**
 * Event reducer + ordered batch (doc 04 §B.2/§B.3/§I.1).
 * `applyDirectoryEvent` mutates a DRAFT; the batch clones each touched field
 * at most once per flush and publishes one setState per store per flush.
 * No-op events must change zero references. Session/status cases live here;
 * transcript and blocking cases delegate to their reducers.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { AssistantMessage, Session, SessionStatus, Todo } from '../lib/nnd/types.ts';
import {
  areSessionStatusesEqual,
  removeById,
  shouldSkipStaleSessionEvent,
  upsertById,
} from './event-equality.ts';
import { applyTranscriptEvent } from './transcript-reducer.ts';
import { applyBlockingEvent } from './blocking-reducer.ts';
import { loose } from './reducer-core.ts';
import { emptyOutcome, type ReducerApi, type BatchOutcome } from './reducer-core.ts';
import { stripSessionDiffSnapshots } from './sanitize.ts';
import { activityRecordFromEvent, mergeActivityRecord } from './activity-log.ts';
import type { DirectoryStore, SyncState } from './types.ts';
import { applyProjectionEvent } from './projection-reducer.ts';
import { adoptSessionProjection } from './nna-projection.ts';

export type { BatchOutcome } from './reducer-core.ts';
export { emptyOutcome } from './reducer-core.ts';

/** Clone-on-first-write batch: the store sees exactly one setState per flush. */
export class DirectoryEventBatch {
  private draft: SyncState;
  private cloned = new Set<keyof SyncState>();
  readonly out: BatchOutcome = emptyOutcome();

  constructor(private readonly store: StoreApi<DirectoryStore>) {
    this.draft = { ...store.getState() };
  }

  private ensure = (field: keyof SyncState): void => {
    if (this.cloned.has(field)) return;
    this.cloned.add(field);
    const value = this.draft[field];
    if (Array.isArray(value)) {
      (this.draft as unknown as Record<string, unknown>)[field as string] = [...(value as unknown[])];
    } else if (value && typeof value === 'object') {
      (this.draft as unknown as Record<string, unknown>)[field as string] = { ...(value as object) };
    }
  };

  private changed = (): void => {
    this.out.changedCount += 1;
  };

  apply(event: HarnessEvent, now: number): void {
    applyDirectoryEvent(this.draft, event, { ensure: this.ensure, changed: this.changed, out: this.out, now });
  }

  /** Publishes cloned fields in ONE setState; returns changedCount. */
  commit(): number {
    if (this.cloned.size === 0) return 0;
    const patch: Partial<SyncState> = {};
    for (const field of this.cloned) {
      (patch as Record<string, unknown>)[field as string] = this.draft[field];
    }
    this.store.setState(patch);
    return this.out.changedCount;
  }
}

/** Reducer entry — pure with respect to the draft (doc 04 §B.2 catalog). */
export function applyDirectoryEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  if (applyProjectionEvent(draft, event, api)) return;
  if (applyActivityEvent(draft, event, api)) return;
  if (applyTranscriptEvent(draft, event, api)) return;
  if (applyBlockingEvent(draft, event, api)) return;
  if (applySessionEvent(draft, event, api)) return;
  applyEnrichmentEvent(draft, event, api);
}

function applyActivityEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): boolean {
  const record = activityRecordFromEvent(event);
  if (!record) return false;
  const next = mergeActivityRecord(draft.activity, record);
  if (next === draft.activity) return true;
  api.ensure('activity');
  draft.activity = next;
  api.changed();
  return true;
}

function applySessionEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): boolean {
  switch (event.type) {
    case 'session.created':
    case 'session.updated':
      applySessionUpsert(draft, event, api);
      return true;
    case 'session.deleted':
      applySessionDeleted(draft, event, api);
      return true;
    case 'session.diff':
      applySessionDiff(draft, event, api);
      return true;
    case 'session.status':
      applySessionStatus(draft, event, api);
      return true;
    case 'session.idle':
    case 'session.error':
      applySessionSettled(draft, event, api);
      return true;
    case 'todo.updated':
      applyTodoUpdated(draft, event, api);
      return true;
    default:
      return false;
  }
}

function recordRevision(draft: SyncState, api: ReducerApi, sessionID: string): void {
  api.ensure('sessionRevision');
  api.ensure('sessionEventRevision');
  draft.sessionRevision += 1;
  draft.sessionEventRevision[sessionID] = draft.sessionRevision;
}

function applySessionUpsert(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const info = (props['info'] ?? props['session']) as Session | undefined;
  if (!info?.id) return;
  const stripped = stripSessionDiffSnapshots({ ...info });
  const current = draft.session.find((s) => s.id === stripped.id);
  if (shouldSkipStaleSessionEvent(current, stripped)) return;
  adoptSessionProjection(current, stripped);
  api.ensure('session');
  api.ensure('sessionEventRevision');
  if (stripped.time.archived) {
    applyArchiveRemoval(draft, stripped, api);
    return;
  }
  if (current && sameSessionRecord(current, stripped)) return;
  const { inserted } = upsertById(draft.session, stripped);
  if (inserted && !stripped.parentID) {
    api.ensure('sessionTotal');
    draft.sessionTotal += 1;
  }
  recordRevision(draft, api, stripped.id);
  draft.sessionListSource = 'live';
  trimSessionList(draft, api);
  api.out.sessionRoutes.push({ sessionID: stripped.id, directory: event.directory ?? '' });
  api.changed();
}

function applyArchiveRemoval(draft: SyncState, stripped: Session, api: ReducerApi): void {
  const removed = removeById(draft.session, stripped.id);
  if (!removed) return;
  if (!stripped.parentID) {
    api.ensure('sessionTotal');
    draft.sessionTotal = Math.max(0, draft.sessionTotal - 1);
  }
  api.ensure('sessionDeletedRevision');
  recordRevision(draft, api, stripped.id);
  draft.sessionDeletedRevision[stripped.id] = draft.sessionRevision;
  cleanupSessionCaches(draft, stripped.id, api);
  api.out.sessionArchived.push({ sessionID: stripped.id, record: stripped });
  api.changed();
}

function applySessionDeleted(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const id = (props['sessionID'] ?? loose(props['info'])['id']) as string | undefined;
  if (!id) return;
  const current = draft.session.find((s) => s.id === id);
  api.ensure('session');
  api.ensure('sessionEventRevision');
  api.ensure('sessionDeletedRevision');
  const removed = removeById(draft.session, id);
  if (removed && !current?.parentID) {
    api.ensure('sessionTotal');
    draft.sessionTotal = Math.max(0, draft.sessionTotal - 1);
  }
  recordRevision(draft, api, id);
  draft.sessionDeletedRevision[id] = draft.sessionRevision;
  cleanupSessionCaches(draft, id, api);
  api.out.sessionRemoved.push(id);
  api.changed();
}

function applySessionDiff(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const sessionID = props['sessionID'] as string | undefined;
  if (!sessionID) return;
  api.ensure('session_diff');
  draft.session_diff[sessionID] = (props['diff'] as SyncState['session_diff'][string]) ?? [];
  api.changed();
}

function applySessionStatus(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const sessionID = props['sessionID'] as string | undefined;
  const status = props['status'] as SessionStatus | undefined;
  if (!sessionID || !status?.type) return;
  if (areSessionStatusesEqual(draft.session_status[sessionID], status)) return;
  api.ensure('session_status');
  draft.session_status[sessionID] = status;
  api.out.statusChanges.push({ sessionID, status });
  api.changed();
}

function applySessionSettled(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const sessionID = props['sessionID'] as string | undefined;
  if (!sessionID) return;
  const idle: SessionStatus = { type: 'idle' };
  if (!areSessionStatusesEqual(draft.session_status[sessionID], idle)) {
    api.ensure('session_status');
    draft.session_status[sessionID] = idle;
    api.out.statusChanges.push({ sessionID, status: idle });
    api.changed();
  }
  api.out.settled.push(event.type === 'session.error'
    ? { sessionID, kind: 'error', error: props['error'] }
    : { sessionID, kind: 'idle' });
  // interrupted-turn reconciliation runs in the SAME batch (doc 04 §D.7)
  finalizeInterruptedTurn(draft, sessionID, api, api.now);
}

function applyTodoUpdated(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const sessionID = props['sessionID'] as string | undefined;
  const todos = props['todos'] as Todo[] | undefined;
  if (!sessionID || !Array.isArray(todos)) return;
  if (JSON.stringify(draft.todo[sessionID] ?? null) === JSON.stringify(todos)) return;
  api.ensure('todo');
  draft.todo[sessionID] = todos;
  api.out.todosPersisted.push({ sessionID, todos });
  api.changed();
}

function applyEnrichmentEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  switch (event.type) {
    case 'vcs.branch.updated': {
      const branch = props['branch'] as string | undefined;
      if (!branch || draft.vcs?.branch === branch) return;
      api.ensure('vcs');
      draft.vcs = { branch };
      api.changed();
      return;
    }
    case 'lsp.updated':
      api.out.lspRefresh = true;
      return;
    case 'project.updated':
      api.out.projectUpdated = props['info'] ?? props['project'] ?? props;
      return;
    case 'server.connected':
    case 'global.disposed':
    case 'server.instance.disposed':
      api.out.globalRefresh = true;
      return;
    default:
      return;
  }
}

function sameSessionRecord(a: Session, b: Session): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Session list trim: over limit drop oldest-by-ID from the front, never a
 * session holding pending permissions (doc 04 §D.4). */
function trimSessionList(draft: SyncState, api: ReducerApi): void {
  while (draft.session.length > draft.limit) {
    const dropped = dropOneTrimmed(draft, api);
    if (!dropped) return;
  }
}

function dropOneTrimmed(draft: SyncState, api: ReducerApi): boolean {
  for (let i = 0; i < draft.session.length; i += 1) {
    const candidate = draft.session[i]!;
    const pending = draft.permission[candidate.id];
    if (pending && pending.length > 0) continue;
    api.ensure('session');
    draft.session.splice(i, 1);
    return true;
  }
  return false;
}

/** Drop every per-session cache for an id (archive/delete cleanup). */
export function cleanupSessionCaches(draft: SyncState, sessionID: string, api: ReducerApi): void {
  api.ensure('message');
  api.ensure('part');
  api.ensure('todo');
  api.ensure('session_diff');
  api.ensure('session_status');
  api.ensure('permission');
  api.ensure('question');
  const messages = draft.message[sessionID];
  if (messages) {
    // Why: native forks retain inherited user IDs; another session may still render their parts.
    const retained = new Set(Object.entries(draft.message).filter(([id]) => id !== sessionID)
      .flatMap(([, rows]) => rows.map(message => message.id)));
    for (const message of messages) if (!retained.has(message.id)) delete draft.part[message.id];
    delete draft.message[sessionID];
  }
  delete draft.todo[sessionID];
  delete draft.session_diff[sessionID];
  delete draft.session_status[sessionID];
  delete draft.permission[sessionID];
  delete draft.question[sessionID];
}

/**
 * Interrupted-turn finalize (doc 04 §D.7): explicit authoritative settle only;
 * requires no pending question/permission; trailing assistant without
 * time.completed completes locally with MessageAbortedError and ACTIVE tool
 * parts finalize as error/"Interrupted" — same batch. Parts already carrying a
 * time.end keep their evidence.
 */
export function finalizeInterruptedTurn(draft: SyncState, sessionID: string, api: ReducerApi, now: number): boolean {
  if (!finalizeEligible(draft, sessionID)) return false;
  const messages = draft.message[sessionID]!;
  const trailing = messages[messages.length - 1] as AssistantMessage;
  api.ensure('message');
  api.ensure('part');
  messages[messages.length - 1] = {
    ...trailing,
    error: trailing.error ?? { name: 'MessageAbortedError' as const, message: 'aborted' },
    time: { ...trailing.time, completed: now },
  };
  finalizeRunningToolParts(draft, trailing.id, now);
  api.changed();
  return true;
}

function finalizeEligible(draft: SyncState, sessionID: string): boolean {
  if ((draft.question[sessionID]?.length ?? 0) > 0) return false;
  if ((draft.permission[sessionID]?.length ?? 0) > 0) return false;
  const messages = draft.message[sessionID];
  if (!messages || messages.length === 0) return false;
  const trailing = messages[messages.length - 1]!;
  return trailing.role === 'assistant' && trailing.time.completed === undefined;
}

function finalizeRunningToolParts(draft: SyncState, messageID: string, now: number): void {
  const parts = draft.part[messageID];
  if (!parts) return;
  draft.part[messageID] = parts.map((part) => {
    const state = loose(part)['state'] as Record<string, unknown>;
    const time = loose(state['time']) as Record<string, unknown>;
    const status = String(state['status'] ?? '');
    const settled = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || time['end'] !== undefined;
    if (part.type !== 'tool' || settled) return part;
    return {
      ...part,
      state: { ...state, status: 'error', error: state['error'] ?? 'Interrupted', time: { ...time, start: time['start'] ?? now, end: now } },
    };
  });
}
