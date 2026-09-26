// SPDX-License-Identifier: Apache-2.0
/**
 * Occurrence-claim contract (doc 12 §C.5). A claim is REFUSED exactly when
 * the stored task is already claimed for THIS occurrence (`lastScheduledFor`
 * within the due slack) — nothing else: an advanced on-disk `nextRunAt` is
 * routinely overwritten by sibling syncs and must never suppress a claim.
 * The claim patch always writes `nextRunAt` (a consumed once slot must be
 * CLEARED, not left stale) and clears `lastError`. Predicates run on the RAW
 * stored record so a version-skewed sibling's task stays claimable.
 */
import { TASK_DUE_SLACK_MS } from './scheduled-constants.ts';

export type RawTask = Record<string, unknown>;
export type StatePatch = Record<string, unknown>;

export function stateOf(task: RawTask): Record<string, unknown> {
  const state = task.state;
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown> : {};
}

/** Refuses exactly an already-claimed occurrence (within the due slack). */
export function canClaimOccurrence(scheduledFor: number): (task: RawTask) => boolean {
  return (task) => {
    const lastScheduled = stateOf(task).lastScheduledFor;
    if (typeof lastScheduled !== 'number' || !Number.isFinite(lastScheduled)) return true;
    return Math.abs(lastScheduled - scheduledFor) > TASK_DUE_SLACK_MS;
  };
}

/** The winner's patch: claim fields + running status + carried next slot. */
export function buildClaimPatch(options: {
  scheduledFor: number;
  lastRunAt: number;
  nextRunAt: number | undefined;
  updatedAt: number;
}): StatePatch {
  return {
    lastScheduledFor: options.scheduledFor,
    lastRunAt: options.lastRunAt,
    lastStatus: 'running',
    lastError: undefined,
    nextRunAt: options.nextRunAt,
    updatedAt: options.updatedAt,
  };
}

/** Manual runs write running status WITHOUT claim fields. */
export function buildManualStartPatch(now: number): StatePatch {
  return { lastRunAt: now, lastStatus: 'running', updatedAt: now };
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

/** Completion patch: terminal status plus the carried next slot. */
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
    nextRunAt: options.nextRunAt,
    updatedAt: options.updatedAt,
  };
  if (options.status === 'error') patch.lastError = options.lastError ?? 'scheduled task run failed';
  else patch.lastSessionId = options.sessionID;
  return patch;
}
