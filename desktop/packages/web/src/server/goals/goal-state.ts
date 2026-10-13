// SPDX-License-Identifier: Apache-2.0
/**
 * Goal state machine (doc 12 §B.3). Pure payload transforms — no I/O — so the
 * whole transition table is unit-testable. `null` from an apply function means
 * the transition is REFUSED (the caller must not write).
 *
 * Terminal statuses are `complete` (final) and `blocked` / `budgetLimited`
 * (resumable). `paused` is always reversible. Settle writes always reset both
 * audit streaks: a fresh Resume gets fresh tolerance.
 */
import {
  GOAL_NOTIFICATION_TITLES,
  GOAL_REASONS,
  GOAL_STATUSES,
  NOTE_CHAR_LIMIT,
  REASON_CHAR_LIMIT,
} from './goal-constants.ts';
import {
  buildGoalPayload,
  cloneGoal,
  type GoalPayload,
  type GoalStatus,
} from './goal-payload.ts';

export type SettleStatus = Extract<GoalStatus, 'complete' | 'blocked' | 'budgetLimited'>;

export type GoalEvent =
  /** T1 — user arms a goal and sends the first prompt. */
  | { type: 'arm'; objective: string; objectiveFile?: boolean; tokenBudget?: number | null; now?: number }
  /** T2 — a tick ran and changed nothing structurally. */
  | { type: 'tick'; now?: number }
  /** T3..T9 — settle with a reason. */
  | { type: 'settle'; status: SettleStatus; reason: string; note?: string; now?: number }
  /** T10/T11 — pause (abort-detected or user-pressed). */
  | { type: 'pause'; reason?: string; now?: number }
  /** T12/T14 — explicit resume / raise-budget retry. */
  | { type: 'resume'; now?: number }
  /** T15 — objective edited in the dialog (reactivate, id preserved). */
  | { type: 'reactivate'; objective?: string; objectiveFile?: boolean; now?: number }
  /** The continuation persist: consume one auto-continuation slot. */
  | { type: 'continue'; now?: number };

export function isActive(goal: GoalPayload): boolean {
  return goal.status === 'active';
}

export function isResumable(goal: GoalPayload): boolean {
  return goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited';
}

export function isFinal(goal: GoalPayload): boolean {
  return goal.status === 'complete';
}

/** T17: re-arming over a `complete` goal is refused (the auditor would
 *  instantly re-complete a goal it just finished). */
export function canArmOver(goal: GoalPayload | null): boolean {
  return goal === null || goal.status !== 'complete';
}

/** T1/T17 — payload written when a goal is armed. */
export function armGoal(
  input: { objective: string; objectiveFile?: boolean; tokenBudget?: number | null; now?: number; existing?: GoalPayload | null },
): GoalPayload | null {
  if (!canArmOver(input.existing ?? null)) return null;
  // §B.1: a goal must carry (objective OR objectiveFile) — arming one the
  // parser would later refuse as "no goal" would hang the loop mid-goal.
  if (input.objectiveFile !== true && input.objective.trim() === '') return null;
  return buildGoalPayload({
    objective: input.objective,
    objectiveFile: input.objectiveFile === true,
    tokenBudget: input.tokenBudget ?? null,
    now: input.now,
  });
}

/** T10/T11 — pause. Only an active goal pauses; anything else is a no-op. */
export function pauseGoal(goal: GoalPayload, reason: string = GOAL_REASONS.pausedAfterAbort, now: number = Date.now()): GoalPayload | null {
  if (goal.status !== 'active') return null;
  return {
    ...cloneGoal(goal),
    status: 'paused',
    statusReason: reason.slice(0, REASON_CHAR_LIMIT),
    updatedAt: now,
  };
}

/** T12/T14 — resume: fresh continuation allowance (`turnsUsed` 0) and a reset
 *  blocked streak. `statusReason:'resumed'` doubles as the UI kickoff signal
 *  and the one-shot suppression of the truncation rule (§B.5.3). */
export function resumeGoal(goal: GoalPayload, now: number = Date.now()): GoalPayload | null {
  if (!isResumable(goal)) return null;
  return {
    ...cloneGoal(goal),
    status: 'active',
    statusReason: GOAL_REASONS.resumed,
    turnsUsed: 0,
    blockedStreak: 0,
    updatedAt: now,
  };
}

/** T15 — objective edited: reactivate in place, keeping id + accounting. */
export function reactivateGoal(
  goal: GoalPayload,
  patch: { objective?: string; objectiveFile?: boolean },
  now: number = Date.now(),
): GoalPayload | null {
  if (isFinal(goal)) return null;
  const next = cloneGoal(goal);
  if (typeof patch.objective === 'string') next.objective = patch.objective;
  if (typeof patch.objectiveFile === 'boolean') next.objectiveFile = patch.objectiveFile;
  next.status = 'active';
  next.statusReason = GOAL_REASONS.resumed;
  next.turnsUsed = 0;
  next.blockedStreak = 0;
  next.auditFailStreak = 0;
  next.updatedAt = now;
  return next;
}

/** T3..T9 — settle. Streaks always reset; the note survives unless replaced. */
export function settleGoal(
  goal: GoalPayload,
  status: SettleStatus,
  reason: string,
  options?: { note?: string; now?: number },
): GoalPayload | null {
  if (goal.status === status) return null;
  const next = cloneGoal(goal);
  next.status = status;
  next.statusReason = reason.slice(0, REASON_CHAR_LIMIT);
  next.blockedStreak = 0;
  next.auditFailStreak = 0;
  if (typeof options?.note === 'string') next.note = options.note.slice(0, NOTE_CHAR_LIMIT);
  next.updatedAt = options?.now ?? Date.now();
  return next;
}

/** The continuation persist (§B.5 step 9): one slot consumed, `statusReason`
 *  cleared (which re-arms the truncation rule a Resume had suppressed). */
export function continueGoal(goal: GoalPayload, now: number = Date.now()): GoalPayload {
  const next = cloneGoal(goal);
  next.turnsUsed = next.turnsUsed + 1;
  next.statusReason = '';
  next.updatedAt = now;
  return next;
}

/** Apply an event to a payload; `null` = refused (write nothing). */
export function applyGoalEvent(goal: GoalPayload | null, event: GoalEvent): GoalPayload | null {
  if (event.type === 'arm') return armGoal({ ...event, existing: goal });
  if (goal === null) return null;
  switch (event.type) {
    case 'tick':
      return goal.status === 'active' ? goal : null;
    case 'settle':
      return settleGoal(goal, event.status, event.reason, { note: event.note, now: event.now });
    case 'pause':
      return pauseGoal(goal, event.reason ?? GOAL_REASONS.pausedAfterAbort, event.now);
    case 'resume':
      return resumeGoal(goal, event.now);
    case 'reactivate':
      return reactivateGoal(goal, { objective: event.objective, objectiveFile: event.objectiveFile }, event.now);
    case 'continue':
      return goal.status === 'active' ? continueGoal(goal, event.now) : null;
    default:
      return null;
  }
}

/** Settle notification title (§B.3); null for non-settling statuses. */
export function notificationTitle(status: GoalStatus): string | null {
  if (status === 'complete') return GOAL_NOTIFICATION_TITLES.complete;
  if (status === 'budgetLimited') return GOAL_NOTIFICATION_TITLES.budgetLimited;
  if (status === 'blocked') return GOAL_NOTIFICATION_TITLES.blocked;
  return null;
}

/** Every status the machine knows (§B.3). */
export function knownStatuses(): readonly GoalStatus[] {
  return GOAL_STATUSES;
}
