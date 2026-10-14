// SPDX-License-Identifier: Apache-2.0
/**
 * Occurrence-claim contract (doc 12 §C.5), extended for F9 at-most-once:
 * a claim is REFUSED when the stored task is already claimed for THIS
 * occurrence (`lastScheduledFor` within the due slack) or when the stored
 * record says the task is disabled (durable stop guard) — nothing else: an
 * advanced on-disk `nextRunAt` is routinely overwritten by sibling syncs and
 * must never suppress a claim. The claim patch writes `nextRunAt` (a consumed
 * once slot must be CLEARED, not left stale), clears `lastError`, and carries
 * the durable dispatch record (operation id + phase) so a crash around native
 * acceptance reconciles by operation ID instead of resubmitting blindly.
 * Predicates run on the RAW stored record so a version-skewed sibling's task
 * stays claimable.
 */
import { createHash } from 'node:crypto';
import { TASK_DUE_SLACK_MS } from './scheduled-constants.ts';

export type RawTask = Record<string, unknown>;
export type StatePatch = Record<string, unknown>;

/** The durable dispatch record riding `state.dispatch` (see runOccurrence).
 *  Phase order carries the crash boundary around native acceptance:
 *  `claimed` → `creating` → `session-created` → `accepted`. `creating` is
 *  written BEFORE session create so a crash at `claimed` may resume the run
 *  (nothing mutated yet), while `creating` itself records that the
 *  session-create outcome is unknown and must never be resubmitted. `pid` is
 *  the claiming process: a booted peer skips a resume while that process is
 *  alive, so only a real restart reconciles the record. */
export interface OccurrenceDispatch {
  scheduledFor: number;
  operationId: string;
  phase: OccurrencePhase;
  sessionId?: string;
  pid?: number;
  updatedAt: number;
}

export const OCCURRENCE_PHASES = ['claimed', 'creating', 'session-created', 'accepted'] as const;
export type OccurrencePhase = (typeof OCCURRENCE_PHASES)[number];

export function stateOf(task: RawTask): Record<string, unknown> {
  const state = task.state;
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown> : {};
}

/** Parses the dispatch record; a damaged record reads as null (the caller
 *  treats it as absent, which keeps the never-blind-resubmit rule: the
 *  stale running marker still blocks any re-claim of that occurrence). */
export function dispatchOf(task: RawTask): OccurrenceDispatch | null {
  const record = stateOf(task).dispatch;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (typeof value.operationId !== 'string' || value.operationId === '') return null;
  if (typeof value.scheduledFor !== 'number' || !Number.isFinite(value.scheduledFor)) return null;
  if (!(OCCURRENCE_PHASES as readonly unknown[]).includes(value.phase)) return null;
  return {
    scheduledFor: value.scheduledFor,
    operationId: value.operationId,
    phase: value.phase as OccurrencePhase,
    ...(typeof value.sessionId === 'string' && value.sessionId !== '' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid >= 0 ? { pid: value.pid } : {}),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** True while the dispatch record still has a live owner (another process,
 *  or this one). A dead or absent pid means the record is orphaned by a crash
 *  and a booting reconciler may settle it; a live owner means a run is in
 *  flight and resuming would race it. */
export function ownedByLiveProcess(dispatch: OccurrenceDispatch, isAlive: (pid: number) => boolean): boolean {
  if (dispatch.pid === undefined) return false;
  return dispatch.pid === process.pid || isAlive(dispatch.pid);
}

/** Bounded pid probe for record-ownership checks (ESRCH → dead). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The claim predicate refuses exactly: an already-claimed occurrence (within
 *  the due slack) OR a task the durable store says the user disabled. The
 *  enabled check closes the stop-race: a disable that reached the store after
 *  this instance armed the slot must still refuse the claim. */
export function canClaimOccurrence(scheduledFor: number): (task: RawTask) => boolean {
  return (task) => {
    if (task.enabled === false) return false;
    const lastScheduled = stateOf(task).lastScheduledFor;
    if (typeof lastScheduled !== 'number' || !Number.isFinite(lastScheduled)) return true;
    return Math.abs(lastScheduled - scheduledFor) > TASK_DUE_SLACK_MS;
  };
}

/** The winner's patch: claim fields + the durable dispatch record + running
 *  status + carried next slot. The dispatch record is written by the SAME
 *  atomic claim, so at-most-once holds across a crash right after the claim:
 *  the record exists with phase `claimed` and a deterministic operation id. */
export function buildClaimPatch(options: {
  scheduledFor: number;
  operationId: string;
  lastRunAt: number;
  nextRunAt: number | undefined;
  updatedAt: number;
}): StatePatch {
  return {
    lastScheduledFor: options.scheduledFor,
    lastRunAt: options.lastRunAt,
    lastStatus: 'running',
    lastError: undefined,
    dispatch: {
      scheduledFor: options.scheduledFor,
      operationId: options.operationId,
      phase: 'claimed',
      pid: process.pid,
      updatedAt: options.updatedAt,
    } satisfies OccurrenceDispatch,
    nextRunAt: options.nextRunAt,
    updatedAt: options.updatedAt,
  };
}

/** Manual runs write running status WITHOUT claim fields. */
export function buildManualStartPatch(now: number): StatePatch {
  return { lastRunAt: now, lastStatus: 'running', updatedAt: now };
}

/** Phase advances run under an exact-state CAS: the record must hold the
 *  expected predecessor phase AND the same operation id, so a stale writer
 *  (a late pipeline from a previous boot, or a sibling process that already
 *  advanced the record) can never regress or clobber a newer record. */
export const EXPECTED_PHASE_BEFORE: Record<'creating' | 'session-created' | 'accepted', OccurrencePhase> = {
  creating: 'claimed',
  'session-created': 'creating',
  accepted: 'session-created',
};

export function canAdvanceDispatch(operationId: string, target: 'creating' | 'session-created' | 'accepted'):
  (task: RawTask) => boolean {
  const expected = EXPECTED_PHASE_BEFORE[target];
  return (task) => {
    const record = dispatchOf(task);
    return record !== null && record.operationId === operationId && record.phase === expected;
  };
}

/** Full-record replacement for a phase advance (the record is small and
 *  rewritten whole; `sessionId` is kept only when the phase knows it, and the
 *  pid moves to the advancing process so record ownership follows execution). */
export function buildDispatchPhasePatch(options: {
  scheduledFor: number;
  operationId: string;
  phase: OccurrencePhase;
  sessionId?: string;
  now: number;
}): StatePatch {
  return {
    dispatch: {
      scheduledFor: options.scheduledFor,
      operationId: options.operationId,
      phase: options.phase,
      ...(options.sessionId !== undefined && options.sessionId !== '' ? { sessionId: options.sessionId } : {}),
      pid: process.pid,
      updatedAt: options.now,
    } satisfies OccurrenceDispatch,
    updatedAt: options.now,
  };
}

/** Deterministic occurrence operation id: the same (task, slot) always maps
 *  to the same identity, which is what lets a restart reconcile a pending
 *  occurrence instead of re-creating its session. Shape satisfies NNA's
 *  bounded external-id rule (`schrun_` + hex digest). */
export function operationIdForOccurrence(taskId: string, scheduledFor: number): string {
  const digest = createHash('sha256').update(`${taskId}\x00${scheduledFor}`).digest('hex').slice(0, 64);
  return `schrun_${digest}`;
}

/** Best-effort error record for a failed claim, gated by the SAME predicate
 * so a winner's claim is never clobbered. Only the named fields change; the
 * persisted next slot is re-armed separately. */
export function buildClaimFailurePatch(error: unknown, now: number): StatePatch {
  const message = error instanceof Error ? error.message : String(error);
  return {
    lastStatus: 'error',
    lastError: `Scheduled claim failed: ${message}`,
    updatedAt: now,
  };
}

/** Completion patch: terminal status plus the carried next slot. The dispatch
 *  record is CLEARED (explicit undefined) so the next occurrence starts from
 *  an absent record, never a stale one. */
export function buildCompletionPatch(options: {
  status: 'success' | 'error';
  lastError?: string;
  sessionID?: string;
  durationMs: number;
  nextRunAt: number | undefined;
  updatedAt: number;
}): StatePatch {
  const patch: StatePatch = {
    lastStatus: options.status,
    lastDurationMs: options.durationMs,
    dispatch: undefined,
    nextRunAt: options.nextRunAt,
    updatedAt: options.updatedAt,
  };
  if (options.status === 'error') patch.lastError = options.lastError ?? 'scheduled task run failed';
  else patch.lastSessionId = options.sessionID;
  return patch;
}
