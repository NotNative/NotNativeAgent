// SPDX-License-Identifier: Apache-2.0
/** NNA-native, receipt-ordered goal accounting. No OpenCode snapshot math. */
import { GOAL_REASONS, MAX_AUTO_TURNS } from './goal-constants.ts';
import { cloneGoal, type GoalPayload } from './goal-payload.ts';
import { pauseGoal, settleGoal } from './goal-state.ts';

export interface NnaGoalTurnReceipt {
  request_id: string;
  outcome: string;
  tokens: number | null;
  measurement: string;
}

export interface NnaGoalEvidence {
  session_id: string;
  turns: NnaGoalTurnReceipt[];
  latest_request_id: string | null;
  window_truncated: boolean;
}

export type GoalEvidenceDecision =
  | { kind: 'wait'; goal: GoalPayload }
  | { kind: 'audit'; goal: GoalPayload; latest: NnaGoalTurnReceipt }
  | { kind: 'continue'; goal: GoalPayload }
  | { kind: 'settle'; goal: GoalPayload };

function blocked(goal: GoalPayload, reason: string, now: number): GoalEvidenceDecision {
  return { kind: 'settle', goal: settleGoal(goal, 'blocked', reason, { now })! };
}

/** Shape and ordering are part of the safety boundary, not merely UI input. */
function validEvidence(raw: unknown, sessionId: string): raw is NnaGoalEvidence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Partial<NnaGoalEvidence>;
  if (value.session_id !== sessionId || !Array.isArray(value.turns)
    || value.turns.length > 200 || typeof value.window_truncated !== 'boolean') return false;
  const seen = new Set<string>();
  for (const turn of value.turns) {
    if (!turn || typeof turn.request_id !== 'string' || turn.request_id.length === 0
      || turn.request_id.length > 128 || seen.has(turn.request_id)
      || typeof turn.outcome !== 'string' || typeof turn.measurement !== 'string') return false;
    seen.add(turn.request_id);
  }
  return value.latest_request_id === (value.turns.at(-1)?.request_id ?? null);
}

/**
 * Returns a persisted goal candidate. The caller must CAS-write it before
 * auditing or continuing; this function performs no I/O or dispatch.
 */
export function decideNnaGoalEvidence(
  goal: GoalPayload,
  sessionId: string,
  evidence: unknown,
  now: number = Date.now(),
): GoalEvidenceDecision {
  if (goal.status !== 'active') return { kind: 'wait', goal };
  if (!validEvidence(evidence, sessionId)) return blocked(goal, GOAL_REASONS.evidenceUnavailable, now);
  const cursor = goal.lastAccountedMessageID;
  const index = cursor ? evidence.turns.findIndex((turn) => turn.request_id === cursor) : -1;
  if ((cursor && index < 0) || (!cursor && evidence.window_truncated)) {
    return blocked(goal, GOAL_REASONS.evidenceGap, now);
  }

  const fresh = evidence.turns.slice(index + 1);
  const next = cloneGoal(goal);
  let total = Math.max(next.tokensUsed, next.tokensCommitted);
  if (!Number.isSafeInteger(total)) return blocked(goal, GOAL_REASONS.usageUnavailable, now);
  for (const receipt of fresh) {
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(receipt.tokens) || (receipt.tokens as number) < 0
      || !['provider', 'estimated', 'mixed'].includes(receipt.measurement)
      || !Number.isSafeInteger(total + (receipt.tokens as number))) {
      return blocked(goal, GOAL_REASONS.usageUnavailable, now);
    }
    total += receipt.tokens as number;
  }
  if (fresh.length > 0 || next.tokensUsed !== total) {
    next.tokensUsed = total;
    next.tokensCommitted = total;
    next.tokensBaseline = 0;
    if (fresh.length > 0) next.lastAccountedMessageID = fresh.at(-1)!.request_id;
    next.updatedAt = now;
  }
  const latest = fresh.at(-1);
  // A quiet tick can see several receipts. Never let a later success erase an
  // earlier cancellation or failure in the same unaccounted window.
  const failed = fresh.some((turn) => !['completed', 'cancelled'].includes(turn.outcome));
  const cancelled = fresh.some((turn) => turn.outcome === 'cancelled');
  if (failed) {
    return blocked(next, GOAL_REASONS.assistantTurnFailed, now);
  }
  if (cancelled && next.statusReason !== GOAL_REASONS.resumed) {
    return { kind: 'settle', goal: pauseGoal(next, GOAL_REASONS.pausedAfterAbort, now)! };
  }
  if (next.tokenBudget !== null && next.tokensUsed >= next.tokenBudget) {
    return { kind: 'settle', goal: settleGoal(next, 'budgetLimited', GOAL_REASONS.budgetReached, { now })! };
  }
  if (next.turnsUsed >= MAX_AUTO_TURNS) return blocked(next, GOAL_REASONS.turnLimit, now);
  // Explicit Resume is a one-shot kickoff over an already-accounted completed
  // or cancelled tail. A failed/unknown tail still requires user intervention.
  if (next.statusReason === GOAL_REASONS.resumed && !latest && index >= 0) {
    const tail = evidence.turns[index];
    if (tail?.outcome === 'cancelled' || tail?.outcome === 'completed') return { kind: 'continue', goal: next };
    return blocked(next, GOAL_REASONS.assistantTurnFailed, now);
  }
  if (cancelled) return { kind: 'continue', goal: next };
  return latest ? { kind: 'audit', goal: next, latest } : { kind: 'wait', goal: next };
}
