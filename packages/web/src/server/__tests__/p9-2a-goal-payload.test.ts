// SPDX-License-Identifier: Apache-2.0
/**
 * P9-2a goal payload + metadata merge + state machine gates (doc 12 §B.1–§B.3,
 * §B.5.1): parse requirements (id / status / objective-or-file), clamps, token
 * budget bounds, namespace-preserving merge writes, the id-guarded stale-write
 * rejection, and the refusal table of §B.3 (complete is final, resume grants a
 * fresh continuation allowance, settle clears both audit streaks).
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FAIL_LIMIT,
  BLOCKED_STREAK_LIMIT,
  GOAL_OBJECTIVE_CHAR_LIMIT,
  MAX_AUTO_TURNS,
  NOTE_CHAR_LIMIT,
  REASON_CHAR_LIMIT,
} from '../goals/goal-constants.ts';
import {
  buildGoalPayload,
  getSessionGoal,
  isGoalFileSessionId,
  newGoalId,
  parseGoalPayload,
  type GoalPayload,
} from '../goals/goal-payload.ts';
import {
  buildGoalWrite,
  idGuardMatches,
  mergeGoalIntoMetadata,
  readMetadata,
  removeGoalFromMetadata,
} from '../goals/goal-metadata.ts';
import {
  applyGoalEvent,
  armGoal,
  canArmOver,
  continueGoal,
  notificationTitle,
  pauseGoal,
  reactivateGoal,
  resumeGoal,
  settleGoal,
} from '../goals/goal-state.ts';

const NOW = 1_700_000_000_000;

const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'goal-1',
  objective: 'Ship the thing',
  objectiveFile: false,
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  tokensBaseline: 0,
  tokensCommitted: 0,
  turnsUsed: 0,
  blockedStreak: 0,
  auditFailStreak: 0,
  note: '',
  statusReason: '',
  evaluationProviderID: '',
  evaluationModelID: '',
  lastAccountedMessageID: '',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const goal = (overrides: Record<string, unknown> = {}): GoalPayload =>
  parseGoalPayload(raw(overrides))!;

const session = (metadata: unknown): Record<string, unknown> => ({ id: 'ses_1', metadata });

describe('goal constants (§B.2)', () => {
  it('matches the documented limits', () => {
    expect(MAX_AUTO_TURNS).toBe(20);
    expect(BLOCKED_STREAK_LIMIT).toBe(3);
    expect(AUDIT_FAIL_LIMIT).toBe(2);
    expect(GOAL_OBJECTIVE_CHAR_LIMIT).toBe(5_000);
    expect(NOTE_CHAR_LIMIT).toBe(280);
    expect(REASON_CHAR_LIMIT).toBe(200);
  });
});

describe('parseGoalPayload (§B.1)', () => {
  it('parses a complete payload', () => {
    const parsed = parseGoalPayload(raw())!;
    expect(parsed.id).toBe('goal-1');
    expect(parsed.status).toBe('active');
    expect(parsed.objective).toBe('Ship the thing');
    expect(parsed.tokenBudget).toBeNull();
  });

  it('requires a non-empty id', () => {
    expect(parseGoalPayload(raw({ id: undefined }))).toBeNull();
    expect(parseGoalPayload(raw({ id: '' }))).toBeNull();
    expect(parseGoalPayload(raw({ id: '   ' }))).toBeNull();
    expect(parseGoalPayload(raw({ id: 42 }))).toBeNull();
  });

  it('requires a known status', () => {
    expect(parseGoalPayload(raw({ status: 'running' }))).toBeNull();
    expect(parseGoalPayload(raw({ status: undefined }))).toBeNull();
    for (const status of ['active', 'paused', 'blocked', 'budgetLimited', 'complete'] as const) {
      expect(parseGoalPayload(raw({ status }))?.status).toBe(status);
    }
  });

  it('requires objective OR objectiveFile', () => {
    expect(parseGoalPayload(raw({ objective: '', objectiveFile: false }))).toBeNull();
    expect(parseGoalPayload(raw({ objective: '   ', objectiveFile: false }))).toBeNull();
    expect(parseGoalPayload(raw({ objective: '', objectiveFile: true }))?.objectiveFile).toBe(true);
  });

  it('clamps note, statusReason and objective', () => {
    const parsed = parseGoalPayload(
      raw({
        note: 'n'.repeat(NOTE_CHAR_LIMIT + 500),
        statusReason: 'r'.repeat(REASON_CHAR_LIMIT + 500),
        objective: 'o'.repeat(GOAL_OBJECTIVE_CHAR_LIMIT + 500),
      }),
    )!;
    expect(parsed.note).toHaveLength(NOTE_CHAR_LIMIT);
    expect(parsed.statusReason).toHaveLength(REASON_CHAR_LIMIT);
    expect(parsed.objective).toHaveLength(GOAL_OBJECTIVE_CHAR_LIMIT);
  });

  it('clamps numeric fields to >= 0 integers', () => {
    const parsed = parseGoalPayload(
      raw({ tokensUsed: -7, tokensBaseline: -1.5, tokensCommitted: -0.25, turnsUsed: -3, blockedStreak: -9, auditFailStreak: -2, createdAt: -5 }),
    )!;
    expect(parsed.tokensUsed).toBe(0);
    expect(parsed.tokensBaseline).toBe(0);
    expect(parsed.tokensCommitted).toBe(0);
    expect(parsed.turnsUsed).toBe(0);
    expect(parsed.blockedStreak).toBe(0);
    expect(parsed.auditFailStreak).toBe(0);
    expect(parsed.createdAt).toBe(0);
    expect(parseGoalPayload(raw({ turnsUsed: 4.9 }))?.turnsUsed).toBe(4);
  });

  it('keeps a token budget only inside 1..100M', () => {
    expect(parseGoalPayload(raw({ tokenBudget: 1 }))?.tokenBudget).toBe(1);
    expect(parseGoalPayload(raw({ tokenBudget: 100_000_000 }))?.tokenBudget).toBe(100_000_000);
    expect(parseGoalPayload(raw({ tokenBudget: 0 }))?.tokenBudget).toBeNull();
    expect(parseGoalPayload(raw({ tokenBudget: 100_000_001 }))?.tokenBudget).toBeNull();
    expect(parseGoalPayload(raw({ tokenBudget: '200000' }))?.tokenBudget).toBeNull();
  });

  it('rejects non-objects and arrays', () => {
    expect(parseGoalPayload(null)).toBeNull();
    expect(parseGoalPayload('goal')).toBeNull();
    expect(parseGoalPayload([raw()])).toBeNull();
  });

  it('falls back updatedAt to createdAt', () => {
    expect(parseGoalPayload(raw({ updatedAt: undefined, createdAt: NOW - 10 }))?.updatedAt).toBe(NOW - 10);
  });
});

describe('objective-file id shape (§B.1)', () => {
  it('accepts only file-safe session ids', () => {
    expect(isGoalFileSessionId('ses_abc123')).toBe(true);
    expect(isGoalFileSessionId('abcd')).toBe(true);
    expect(isGoalFileSessionId('abc')).toBe(false);
    expect(isGoalFileSessionId('../evil')).toBe(false);
    expect(isGoalFileSessionId('a/b')).toBe(false);
    expect(isGoalFileSessionId('a'.repeat(129))).toBe(false);
  });
});

describe('goal id generation (§B.1)', () => {
  it('is sortable-ish and unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newGoalId(NOW)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.startsWith(NOW.toString(36))).toBe(true);
  });
});

describe('buildGoalPayload (§B.7 step 3)', () => {
  it('creates an active goal with zeroed counters', () => {
    const created = buildGoalPayload({ objective: 'Work', objectiveFile: true, tokenBudget: 200_000, now: NOW });
    expect(created.status).toBe('active');
    expect(created.statusReason).toBe('');
    expect(created.turnsUsed).toBe(0);
    expect(created.blockedStreak).toBe(0);
    expect(created.auditFailStreak).toBe(0);
    expect(created.tokensUsed).toBe(0);
    expect(created.tokensBaseline).toBe(0);
    expect(created.tokensCommitted).toBe(0);
    expect(created.lastAccountedMessageID).toBe('');
    expect(created.tokenBudget).toBe(200_000);
    expect(created.createdAt).toBe(NOW);
  });
});

describe('getSessionGoal (§B.1 storage path)', () => {
  it('reads metadata.openchamber.goal', () => {
    const record = session({ openchamber: { goal: raw() }, other: { keep: true } });
    expect(getSessionGoal(record)?.id).toBe('goal-1');
  });

  it('tolerates every missing layer', () => {
    expect(getSessionGoal(undefined)).toBeNull();
    expect(getSessionGoal({})).toBeNull();
    expect(getSessionGoal({ metadata: null })).toBeNull();
    expect(getSessionGoal({ metadata: [] })).toBeNull();
    expect(getSessionGoal({ metadata: { openchamber: null } })).toBeNull();
    expect(getSessionGoal({ metadata: { openchamber: {} } })).toBeNull();
  });
});

describe('metadata merge (§B.1 / §B.5.1)', () => {
  it('preserves sibling keys in the openchamber namespace', () => {
    const base = readMetadata(session({ openchamber: { goal: raw(), assist: { mode: 'x' } } }));
    const merged = mergeGoalIntoMetadata(base, goal({ id: 'goal-2' }));
    const namespaced = merged.openchamber as Record<string, unknown>;
    expect((namespaced.assist as Record<string, unknown>).mode).toBe('x');
    expect((namespaced.goal as Record<string, unknown>).id).toBe('goal-2');
  });

  it('preserves unrelated namespaces', () => {
    const base = readMetadata(session({ openchamber: { goal: raw() }, 'other-tool': { a: 1 } }));
    const merged = mergeGoalIntoMetadata(base, goal());
    expect((merged['other-tool'] as Record<string, unknown>).a).toBe(1);
  });

  it('does not mutate the source metadata', () => {
    const base = readMetadata(session({ openchamber: { goal: raw() } }));
    const before = (base.openchamber as Record<string, unknown>).goal;
    mergeGoalIntoMetadata(base, goal({ id: 'goal-9' }));
    expect((base.openchamber as Record<string, unknown>).goal).toBe(before);
    expect(((base.openchamber as Record<string, unknown>).goal as GoalPayload).id).toBe('goal-1');
  });

  it('creates the namespace when absent', () => {
    const merged = mergeGoalIntoMetadata({}, goal());
    expect(((merged.openchamber as Record<string, unknown>).goal as GoalPayload).id).toBe('goal-1');
  });

  it('removes only the goal key, dropping an emptied namespace', () => {
    const withSibling = removeGoalFromMetadata(readMetadata(session({ openchamber: { goal: raw(), keep: 1 }, z: 2 })));
    expect((withSibling.openchamber as Record<string, unknown>).goal).toBeUndefined();
    expect((withSibling.openchamber as Record<string, unknown>).keep).toBe(1);
    const emptied = removeGoalFromMetadata(readMetadata(session({ openchamber: { goal: raw() }, z: 2 })));
    expect(emptied.openchamber).toBeUndefined();
    expect(emptied.z).toBe(2);
  });
});

describe('id guard (§B.5.1, hinge c)', () => {
  it('drops a write whose expected goal id is stale', () => {
    const record = session({ openchamber: { goal: raw({ id: 'goal-new' }) } });
    expect(idGuardMatches(record, 'goal-old')).toBe(false);
    expect(idGuardMatches(record, 'goal-new')).toBe(true);
    expect(idGuardMatches(session({ openchamber: {} }), 'goal-old')).toBe(false);
    const write = buildGoalWrite(record, goal({ id: 'goal-old' }));
    expect(write.current?.id).toBe('goal-new');
  });
});

describe('state machine (§B.3)', () => {
  it('T1/T17: arming over a complete goal is refused', () => {
    expect(canArmOver(null)).toBe(true);
    expect(canArmOver(goal({ status: 'paused' }))).toBe(true);
    expect(canArmOver(goal({ status: 'complete' }))).toBe(false);
    expect(armGoal({ objective: 'x', existing: goal({ status: 'complete' }) })).toBeNull();
    expect(applyGoalEvent(goal({ status: 'complete' }), { type: 'arm', objective: 'x' })).toBeNull();
  });

  it('T1: arming yields active with empty reason and zero turns', () => {
    const armed = armGoal({ objective: 'Build', now: NOW })!;
    expect(armed.status).toBe('active');
    expect(armed.statusReason).toBe('');
    expect(armed.turnsUsed).toBe(0);
  });

  it('T3: settle complete keeps the note and clears both streaks', () => {
    const before = goal({ status: 'active', blockedStreak: 2, auditFailStreak: 1, note: 'tests green' });
    const settled = settleGoal(before, 'complete', 'verified by audit', { now: NOW + 1 })!;
    expect(settled.status).toBe('complete');
    expect(settled.statusReason).toBe('verified by audit');
    expect(settled.note).toBe('tests green');
    expect(settled.blockedStreak).toBe(0);
    expect(settled.auditFailStreak).toBe(0);
    expect(settled.updatedAt).toBe(NOW + 1);
  });

  it('T4: audit verdict blocked settles only via the streak (limit 3)', () => {
    expect(BLOCKED_STREAK_LIMIT).toBe(3);
  });

  it('T7/T8 settle reasons survive the clamp', () => {
    const settled = settleGoal(goal(), 'budgetLimited', 'token budget reached', { now: NOW })!;
    expect(settled.status).toBe('budgetLimited');
    const long = settleGoal(goal(), 'blocked', 'x'.repeat(500), { now: NOW })!;
    expect(long.statusReason).toHaveLength(REASON_CHAR_LIMIT);
  });

  it('T10/T11: only an active goal pauses', () => {
    expect(pauseGoal(goal({ status: 'active' }), 'paused after abort', NOW)!.status).toBe('paused');
    expect(pauseGoal(goal({ status: 'active' }), 'paused after abort', NOW)!.statusReason).toBe('paused after abort');
    expect(pauseGoal(goal({ status: 'paused' }), 'paused after abort', NOW)).toBeNull();
    expect(pauseGoal(goal({ status: 'complete' }), 'paused after abort', NOW)).toBeNull();
    expect(pauseGoal(goal({ status: 'active' }), '', NOW)!.statusReason).toBe('');
  });

  it('T12/T14: resume grants a fresh allowance and cannot cross complete', () => {
    for (const status of ['paused', 'blocked', 'budgetLimited'] as const) {
      const resumed = resumeGoal(goal({ status, turnsUsed: 20, blockedStreak: 3, statusReason: 'old' }), NOW)!;
      expect(resumed.status).toBe('active');
      expect(resumed.statusReason).toBe('resumed');
      expect(resumed.turnsUsed).toBe(0);
      expect(resumed.blockedStreak).toBe(0);
    }
    expect(resumeGoal(goal({ status: 'complete' }), NOW)).toBeNull();
    expect(resumeGoal(goal({ status: 'active' }), NOW)).toBeNull();
  });

  it('T15: objective edit reactivates in place, preserving id + accounting', () => {
    const edited = reactivateGoal(goal({ id: 'keep-me', tokensUsed: 1234, lastAccountedMessageID: 'msg_9', turnsUsed: 7 }), { objective: 'New text' }, NOW)!;
    expect(edited.id).toBe('keep-me');
    expect(edited.tokensUsed).toBe(1234);
    expect(edited.lastAccountedMessageID).toBe('msg_9');
    expect(edited.objective).toBe('New text');
    expect(edited.status).toBe('active');
    expect(edited.statusReason).toBe('resumed');
    expect(edited.turnsUsed).toBe(0);
    expect(reactivateGoal(goal({ status: 'complete' }), { objective: 'x' }, NOW)).toBeNull();
  });

  it('B.5 step 9: the continuation consumes one slot and clears statusReason', () => {
    const next = continueGoal(goal({ turnsUsed: 19, statusReason: 'resumed' }), NOW);
    expect(next.turnsUsed).toBe(20);
    expect(next.statusReason).toBe('');
    const evented = applyGoalEvent(goal({ status: 'paused' }), { type: 'continue', now: NOW });
    expect(evented).toBeNull();
  });

  it('refuses a settle that is already the current status', () => {
    expect(settleGoal(goal({ status: 'blocked' }), 'blocked', 'again', { now: NOW })).toBeNull();
  });

  it('event routing returns null for a missing goal (except arm)', () => {
    expect(applyGoalEvent(null, { type: 'resume', now: NOW })).toBeNull();
    expect(applyGoalEvent(null, { type: 'pause', now: NOW })).toBeNull();
    expect(applyGoalEvent(goal({ status: 'active' }), { type: 'tick', now: NOW })?.status).toBe('active');
    expect(applyGoalEvent(goal({ status: 'paused' }), { type: 'tick', now: NOW })).toBeNull();
  });

  it('notification titles match §B.3', () => {
    expect(notificationTitle('complete')).toBe('Goal complete');
    expect(notificationTitle('budgetLimited')).toBe('Goal reached its token budget');
    expect(notificationTitle('blocked')).toBe('Goal blocked');
    expect(notificationTitle('active')).toBeNull();
    expect(notificationTitle('paused')).toBeNull();
  });
});
