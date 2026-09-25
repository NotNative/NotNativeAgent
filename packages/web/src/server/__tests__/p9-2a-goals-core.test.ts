// SPDX-License-Identifier: Apache-2.0
/**
 * P9-2a core slice tests: goal payload schema (§B.1/§B.2), metadata merge +
 * id guard (§B.1/§B.5.1), and the state machine (§B.3). The runtime tick and
 * its end-to-end audit hinges (20-continues, 3-streaks through a live loop)
 * land with P9-2b; these pin the layer it will stand on, including the
 * counter/hinge alignment that makes those limits enforceable.
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIT_FAIL_LIMIT,
  BLOCKED_STREAK_LIMIT,
  GOAL_NOTIFICATION_TITLES,
  GOAL_REASONS,
  IDLE_QUIET_MS,
  KICKOFF_QUIET_MS,
  MAX_AUTO_TURNS,
  NOTE_CHAR_LIMIT,
  REASON_CHAR_LIMIT,
  RESUME_KICKOFF_MS,
  TOKEN_BUDGET_MAX,
} from '../goals/goal-constants.ts';
import {
  buildGoalWrite,
  idGuardMatches,
  mergeGoalIntoMetadata,
  removeGoalFromMetadata,
} from '../goals/goal-metadata.ts';
import {
  buildGoalPayload,
  getSessionGoal,
  isGoalFileSessionId,
  newGoalId,
  parseGoalPayload,
} from '../goals/goal-payload.ts';
import { applyGoalEvent, armGoal, canArmOver, notificationTitle } from '../goals/goal-state.ts';

const objective = 'make the release gates honest';

function armedGoal() {
  return buildGoalPayload({ objective, objectiveFile: false, now: 1000 });
}

function sessionWith(goal: unknown, extraNamespaceKeys?: Record<string, unknown>) {
  return {
    metadata: {
      nnd: { ...(extraNamespaceKeys ?? {}), ...(goal === undefined ? {} : { goal }) },
      'other-app': { keeps: 'this' },
    },
  };
}

describe('§B.2 constants', () => {
  it('pins the load-bearing autonomy numbers verbatim', () => {
    expect(MAX_AUTO_TURNS).toBe(20);
    expect(BLOCKED_STREAK_LIMIT).toBe(3);
    expect(AUDIT_FAIL_LIMIT).toBe(2);
    expect(IDLE_QUIET_MS).toBe(15_000);
    expect(KICKOFF_QUIET_MS).toBe(3_000);
    expect(RESUME_KICKOFF_MS).toBe(250);
    expect(TOKEN_BUDGET_MAX).toBe(100_000_000);
    expect(NOTE_CHAR_LIMIT).toBe(280);
    expect(REASON_CHAR_LIMIT).toBe(200);
  });
});

describe('§B.1 payload parsing', () => {
  it('accepts a valid record and keeps every field', () => {
    const goal = armedGoal();
    const parsed = parseGoalPayload({ ...goal, evaluationProviderID: 'nnd-mock' });
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(goal.id);
    expect(parsed?.evaluationProviderID).toBe('nnd-mock');
    expect(parsed?.status).toBe('active');
  });

  it('rejects empty id, unknown status, and objectiveless records', () => {
    const goal = armedGoal();
    expect(parseGoalPayload({ ...goal, id: '   ' })).toBeNull();
    expect(parseGoalPayload({ ...goal, status: 'exploding' })).toBeNull();
    expect(parseGoalPayload({ ...goal, objective: '  ', objectiveFile: false })).toBeNull();
    expect(parseGoalPayload(null)).toBeNull();
    expect(parseGoalPayload([goal])).toBeNull();
  });

  it('tolerates an objectiveFile goal with no inline text', () => {
    const parsed = parseGoalPayload({ id: 'abcd', status: 'active', objective: '', objectiveFile: true });
    expect(parsed?.objectiveFile).toBe(true);
  });

  it('clamps hostile text and numeric fields into documented ranges', () => {
    const parsed = parseGoalPayload({
      id: 'x1',
      status: 'paused',
      objective: 'o'.repeat(9_000),
      objectiveFile: false,
      note: 'n'.repeat(900),
      statusReason: 'r'.repeat(900),
      tokensUsed: -5,
      blockedStreak: 2.7,
    });
    expect(parsed?.objective.length).toBe(5_000);
    expect(parsed?.note.length).toBe(NOTE_CHAR_LIMIT);
    expect(parsed?.statusReason.length).toBe(REASON_CHAR_LIMIT);
    expect(parsed?.tokensUsed).toBe(0);
    expect(parsed?.blockedStreak).toBe(2);
  });

  it('drops token budgets outside 1..100_000_000', () => {
    const goal = armedGoal();
    expect(parseGoalPayload({ ...goal, tokenBudget: 0 })?.tokenBudget).toBeNull();
    expect(parseGoalPayload({ ...goal, tokenBudget: TOKEN_BUDGET_MAX + 1 })?.tokenBudget).toBeNull();
    expect(parseGoalPayload({ ...goal, tokenBudget: 7_500 })?.tokenBudget).toBe(7_500);
  });

  it('reads the goal out of session records without throwing', () => {
    expect(getSessionGoal(sessionWith(armedGoal()))?.objective).toBe(objective);
    expect(getSessionGoal(sessionWith(undefined))).toBeNull();
    expect(getSessionGoal({ metadata: 'not-an-object' })).toBeNull();
    expect(getSessionGoal(null)).toBeNull();
  });

  it('validates the objective-file session id shape BEFORE any filesystem use', () => {
    expect(isGoalFileSessionId('ses_valid_1')).toBe(true);
    expect(isGoalFileSessionId('..')).toBe(false);
    expect(isGoalFileSessionId('ab')).toBe(false);
    expect(isGoalFileSessionId('bad/../etc')).toBe(false);
    expect(isGoalFileSessionId('A'.repeat(128))).toBe(true);
    expect(isGoalFileSessionId('A'.repeat(129))).toBe(false);
  });

  it('mints distinct goal ids (§B.1 stale-write guard key)', () => {
    const ids = new Set([newGoalId(1), newGoalId(1), newGoalId(2), newGoalId(3)]);
    expect(ids.size).toBe(4);
  });
});

describe('§B.1/§B.5.1 metadata merge + id guard', () => {
  it('merges into the namespace and preserves every unrelated key', () => {
    const merged = mergeGoalIntoMetadata(sessionWith(undefined).metadata, armedGoal());
    const chamber = merged.nnd as Record<string, unknown>;
    expect(chamber.goal).toBeDefined();
    expect(merged['other-app']).toEqual({ keeps: 'this' });
  });

  it('keeps sibling nnd keys when writing and when removing only the goal', () => {
    const merged = mergeGoalIntoMetadata(sessionWith(undefined, { panel: 'left' }).metadata, armedGoal());
    expect((merged.nnd as Record<string, unknown>).panel).toBe('left');
    const removed = removeGoalFromMetadata(merged);
    expect((removed.nnd as Record<string, unknown>).panel).toBe('left');
    expect((removed.nnd as Record<string, unknown>).goal).toBeUndefined();
  });

  it('removes the namespace entirely once it is empty', () => {
    const removed = removeGoalFromMetadata(sessionWith(armedGoal()).metadata);
    expect(removed.nnd).toBeUndefined();
    expect(removed['other-app']).toEqual({ keeps: 'this' });
  });

  it('buildGoalWrite returns NNA goal body with the current id guard', () => {
    const next = { ...armedGoal(), id: 'next-id' };
    const existing = armedGoal();
    const write = buildGoalWrite(sessionWith(existing, { goalRevision: 3 }), next);
    expect(write.body).toEqual({ goal: next, expected_id: existing.id, expected_revision: 3 });
    expect(write.current?.id).not.toBe('next-id');
  });

  it('id guard: matches same id, rejects replaced or missing goals', () => {
    const goal = armedGoal();
    expect(idGuardMatches(sessionWith(goal), goal.id)).toBe(true);
    expect(idGuardMatches(sessionWith({ ...goal, id: 'replaced' }), goal.id)).toBe(false);
    expect(idGuardMatches(sessionWith(undefined), goal.id)).toBe(false);
  });
});

describe('§B.3 state machine', () => {
  it('T1 arm writes a fresh active goal with zeroed counters', () => {
    const goal = armGoal({ objective, now: 2222 });
    expect(goal?.status).toBe('active');
    expect(goal?.statusReason).toBe('');
    expect(goal?.turnsUsed).toBe(0);
    expect(goal?.createdAt).toBe(2222);
    expect(armGoal({ objective: '', objectiveFile: false })).toBeNull();
  });

  it('T17 refuses to arm over a complete goal', () => {
    const done = { ...armedGoal(), status: 'complete' as const };
    expect(canArmOver(done)).toBe(false);
    expect(armGoal({ objective, existing: done })).toBeNull();
  });

  it('T10/T11 pause only from active', () => {
    const goal = armedGoal();
    expect(applyGoalEvent(goal, { type: 'pause' })?.status).toBe('paused');
    expect(applyGoalEvent(goal, { type: 'pause' })?.statusReason).toBe(GOAL_REASONS.pausedAfterAbort);
    expect(applyGoalEvent({ ...goal, status: 'paused' as const }, { type: 'pause' })).toBeNull();
    expect(applyGoalEvent({ ...goal, status: 'complete' as const }, { type: 'pause' })).toBeNull();
  });

  it('T12/T14 resume resets the loop state from every resumable status', () => {
    for (const status of ['paused', 'blocked', 'budgetLimited'] as const) {
      const resumed = applyGoalEvent({ ...armedGoal(), status, turnsUsed: 19, blockedStreak: 2 }, { type: 'resume' });
      expect(resumed?.status).toBe('active');
      expect(resumed?.statusReason).toBe(GOAL_REASONS.resumed);
      expect(resumed?.turnsUsed).toBe(0);
      expect(resumed?.blockedStreak).toBe(0);
    }
    expect(applyGoalEvent({ ...armedGoal(), status: 'complete' as const }, { type: 'resume' })).toBeNull();
  });

  it('T15 objective edit reactivates in place, keeping id and accounting', () => {
    const goal = { ...armedGoal(), status: 'paused' as const, tokensCommitted: 4000, turnsUsed: 5 };
    const edited = applyGoalEvent(goal, { type: 'reactivate', objective: 'new text' });
    expect(edited?.id).toBe(goal.id);
    expect(edited?.tokensCommitted).toBe(4000);
    expect(edited?.status).toBe('active');
    expect(edited?.statusReason).toBe(GOAL_REASONS.resumed);
    expect(edited?.blockedStreak).toBe(0);
    expect(edited?.auditFailStreak).toBe(0);
  });

  it('T3..T9 settle always resets both audit streaks and clamps the reason', () => {
    const running = { ...armedGoal(), blockedStreak: 2, auditFailStreak: 1 };
    const settled = applyGoalEvent(running, { type: 'settle', status: 'blocked', reason: 'r'.repeat(400) });
    expect(settled?.blockedStreak).toBe(0);
    expect(settled?.auditFailStreak).toBe(0);
    expect(settled?.statusReason.length).toBe(REASON_CHAR_LIMIT);
    expect(settled?.note).toBe('');
    const withNote = applyGoalEvent(running, { type: 'settle', status: 'complete', reason: GOAL_REASONS.verifiedByAudit, note: 'shipped' });
    expect(withNote?.note).toBe('shipped');
    expect(applyGoalEvent({ ...running, status: 'complete' as const }, { type: 'settle', status: 'complete', reason: 'again' })).toBeNull();
  });

  it('continues consume exactly one slot each and re-arm the truncation rule', () => {
    let goal = armedGoal();
    goal = applyGoalEvent(goal, { type: 'settle', status: 'complete', reason: 'x' }) ?? goal;
    goal = applyGoalEvent(armedGoal(), { type: 'continue' }) ?? goal;
    expect(goal.turnsUsed).toBe(1);
    expect(goal.statusReason).toBe('');
    expect(applyGoalEvent({ ...armedGoal(), status: 'paused' as const }, { type: 'continue' })).toBeNull();
  });

  it('the 20-continuation hinge is enforceable: counter meets MAX_AUTO_TURNS exactly at 20', () => {
    let goal = armedGoal();
    for (let index = 0; index < MAX_AUTO_TURNS; index += 1) {
      goal = applyGoalEvent(goal, { type: 'continue' }) ?? goal;
    }
    expect(goal.turnsUsed).toBe(MAX_AUTO_TURNS);
    // T8's trigger is `turnsUsed >= MAX_AUTO_TURNS` at tick time; the settle
    // it performs is representable and streak-clean:
    const settled = applyGoalEvent(goal, { type: 'settle', status: 'blocked', reason: GOAL_REASONS.turnLimit });
    expect(settled?.status).toBe('blocked');
    expect(settled?.statusReason).toBe(GOAL_REASONS.turnLimit);
  });

  it('a fresh resume grants a full second life (streak + turn reset)', () => {
    let goal = armedGoal();
    for (let index = 0; index < BLOCKED_STREAK_LIMIT; index += 1) {
      goal = { ...goal, blockedStreak: goal.blockedStreak + 1 };
    }
    const settled = applyGoalEvent(goal, { type: 'settle', status: 'blocked', reason: GOAL_REASONS.blockedPerAudit });
    const second = applyGoalEvent(settled ?? goal, { type: 'resume' });
    expect(second?.turnsUsed).toBe(0);
    expect(second?.blockedStreak).toBe(0);
    expect(second?.status).toBe('active');
  });

  it('tick events pass through only for active goals', () => {
    expect(applyGoalEvent(armedGoal(), { type: 'tick' })).not.toBeNull();
    expect(applyGoalEvent({ ...armedGoal(), status: 'blocked' as const }, { type: 'tick' })).toBeNull();
    expect(applyGoalEvent(null, { type: 'tick' })).toBeNull();
  });

  it('notification titles match §B.3 for exactly the settling statuses', () => {
    expect(notificationTitle('complete')).toBe(GOAL_NOTIFICATION_TITLES.complete);
    expect(notificationTitle('budgetLimited')).toBe(GOAL_NOTIFICATION_TITLES.budgetLimited);
    expect(notificationTitle('blocked')).toBe(GOAL_NOTIFICATION_TITLES.blocked);
    expect(notificationTitle('active')).toBeNull();
    expect(notificationTitle('paused')).toBeNull();
  });
});
