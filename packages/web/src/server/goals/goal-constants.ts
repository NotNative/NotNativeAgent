// SPDX-License-Identifier: Apache-2.0
/**
 * Session-goal constants and hard limits (doc 12 §B.2). Every number here is a
 * load-bearing part of the autonomy contract: `MAX_AUTO_TURNS` bounds how long
 * an unattended loop may run, the streak limits bound how much the auditor is
 * trusted, and the char limits bound what crosses the small-model seam.
 */

/** Quiet window after `idle` before the audit tick fires. */
export const IDLE_QUIET_MS = 15_000;
/** Quiet window for a freshly-created goal on an idle session. */
export const KICKOFF_QUIET_MS = 3_000;
/** Quiet window for an explicit Resume (immediate-feel nudge). */
export const RESUME_KICKOFF_MS = 250;
/** Hard cap of auto-continuations per goal id → beyond: settle `blocked`. */
export const MAX_AUTO_TURNS = 20;
/** Consecutive `blocked` audit verdicts required to settle blocked. */
export const BLOCKED_STREAK_LIMIT = 3;
/** Consecutive unavailable/failed audits before settle blocked. */
export const AUDIT_FAIL_LIMIT = 2;
/** Objective clamp (store + UI). */
export const GOAL_OBJECTIVE_CHAR_LIMIT = 5_000;
/** Per-message text cap fed to the auditor. */
export const TRANSCRIPT_PART_CHAR_LIMIT = 6_000;
/** `note` clamp. */
export const NOTE_CHAR_LIMIT = 280;
/** `statusReason` clamp. */
export const REASON_CHAR_LIMIT = 200;
/** Per-harness-call timeout. */
export const FETCH_TIMEOUT_MS = 10_000;
/** Messages fetched per tick for accounting/audit. */
export const MESSAGE_FETCH_LIMIT = 40;
/** Server-created token budget upper bound (§B.1). */
export const TOKEN_BUDGET_MAX = 100_000_000;
/** Distilled objective budget when the raw text is too long (§B.6.3). */
export const DISTILLED_OBJECTIVE_CHAR_LIMIT = 4_000;

/** Per-audit route timeout: NNA holds a 25 s audit deadline and its own
 *  listener caps forwarded calls at 30 s, so the loop must wait beyond both. */
export const AUDIT_CALL_TIMEOUT_MS = 40_000;

/** Settle reasons written verbatim into `statusReason` (§B.3). */
export const GOAL_REASONS = {
  verifiedByAudit: 'verified by audit',
  markedByUser: 'marked by user',
  blockedPerAudit: 'blocked per audit',
  auditUnavailable: 'progress audit unavailable',
  assistantTurnFailed: 'assistant turn failed',
  budgetReached: 'token budget reached',
  turnLimit: 'auto-continuation limit reached',
  repeatedTruncation: 'repeated output truncation',
  evidenceUnavailable: 'goal turn evidence unavailable',
  evidenceGap: 'goal turn evidence cursor missing',
  usageUnavailable: 'goal token usage unavailable',
  pausedAfterAbort: 'paused after abort',
  resumed: 'resumed',
} as const;

/** Settle notification titles (§B.3). */
export const GOAL_NOTIFICATION_TITLES = {
  complete: 'Goal complete',
  budgetLimited: 'Goal reached its token budget',
  blocked: 'Goal blocked',
} as const;

/** Goal statuses (§B.3). */
export const GOAL_STATUSES = ['active', 'paused', 'blocked', 'budgetLimited', 'complete'] as const;

/** Statuses a goal may rest in forever without the loop acting. */
export const GOAL_TERMINAL_STATUSES = ['complete', 'blocked', 'budgetLimited'] as const;
