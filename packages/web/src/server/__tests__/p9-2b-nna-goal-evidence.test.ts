// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildGoalPayload } from '../goals/goal-payload.ts';
import { decideNnaGoalEvidence, type NnaGoalTurnReceipt } from '../goals/nna-goal-evidence.ts';

const sessionId = 'ses_goal_test';
const base = () => buildGoalPayload({ objective: 'Ship safely', objectiveFile: false, tokenBudget: 100, now: 10 });
const receipt = (request_id: string, tokens: number | null, outcome = 'completed'): NnaGoalTurnReceipt => ({
  request_id, tokens, outcome, measurement: tokens === null ? 'unavailable' : 'provider',
});
const feed = (turns: NnaGoalTurnReceipt[], window_truncated = false) => ({
  session_id: sessionId, turns, latest_request_id: turns.at(-1)?.request_id ?? null, window_truncated,
});

describe('NNA-native goal evidence decision', () => {
  it('charges only receipts after the seeded pre-goal cursor, in feed order', () => {
    const goal = { ...base(), lastAccountedMessageID: 'z-before' };
    const result = decideNnaGoalEvidence(goal, sessionId,
      feed([receipt('z-before', 900), receipt('a-after', 20), receipt('b-after', 30)]), 20);
    expect(result.kind).toBe('audit');
    expect(result.goal.tokensUsed).toBe(50);
    expect(result.goal.tokensCommitted).toBe(50);
    expect(result.goal.lastAccountedMessageID).toBe('b-after');
    expect(goal.tokensUsed).toBe(0);
    expect(decideNnaGoalEvidence(result.goal, sessionId,
      feed([receipt('z-before', 900), receipt('a-after', 20), receipt('b-after', 30)])).kind).toBe('wait');
  });

  it('keeps the monotonic floor and stops exactly at budget', () => {
    const goal = { ...base(), lastAccountedMessageID: 'old', tokensUsed: 80, tokensCommitted: 70 };
    const result = decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 1), receipt('new', 20)]), 20);
    expect(result.kind).toBe('settle');
    expect(result.goal.status).toBe('budgetLimited');
    expect(result.goal.tokensUsed).toBe(100);
    expect(result.goal.lastAccountedMessageID).toBe('new');
  });

  it('honors a committed usage floor even when no new receipt arrives', () => {
    const goal = { ...base(), tokensUsed: 80, tokensCommitted: 100, lastAccountedMessageID: 'old' };
    const result = decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 1)]));
    expect(result.goal.status).toBe('budgetLimited');
    expect(result.goal.tokensUsed).toBe(100);
    expect(result.goal.lastAccountedMessageID).toBe('old');
  });

  it('stops at the twenty-continuation cap even without a new receipt', () => {
    const result = decideNnaGoalEvidence({ ...base(), turnsUsed: 20 }, sessionId, feed([]));
    expect(result.kind).toBe('settle');
    expect(result.goal.status).toBe('blocked');
    expect(result.goal.statusReason).toBe('auto-continuation limit reached');
  });

  it('pauses a measured cancellation, blocks a failed turn, and leaves inactive goals alone', () => {
    const cancelled = decideNnaGoalEvidence(base(), sessionId, feed([receipt('cancel', 4, 'cancelled')]));
    expect(cancelled.goal.status).toBe('paused');
    expect(cancelled.goal.tokensUsed).toBe(4);
    expect(decideNnaGoalEvidence(base(), sessionId, feed([receipt('fail', 4, 'failed')])).goal.status).toBe('blocked');
    const inactive = { ...base(), status: 'paused' as const };
    expect(decideNnaGoalEvidence(inactive, sessionId, null)).toEqual({ kind: 'wait', goal: inactive });
  });

  it('does not let a later completed receipt conceal an earlier interruption', () => {
    const cancelled = decideNnaGoalEvidence(base(), sessionId,
      feed([receipt('cancel', 4, 'cancelled'), receipt('later', 6)]));
    expect(cancelled.kind).toBe('settle');
    expect(cancelled.goal.status).toBe('paused');
    expect(cancelled.goal.tokensUsed).toBe(10);
    expect(cancelled.goal.lastAccountedMessageID).toBe('later');
    const failed = decideNnaGoalEvidence(base(), sessionId,
      feed([receipt('fail', 4, 'failed'), receipt('later', 6)]));
    expect(failed.goal.status).toBe('blocked');
    expect(failed.goal.tokensUsed).toBe(10);
    const resumed = decideNnaGoalEvidence({ ...base(), statusReason: 'resumed' }, sessionId,
      feed([receipt('cancel', 4, 'cancelled'), receipt('fail', 6, 'failed')]));
    expect(resumed.kind).toBe('settle');
    expect(resumed.goal.status).toBe('blocked');
  });

  it('kicks off explicit Resume over an accounted tail, without bypassing safety stops', () => {
    const goal = { ...base(), statusReason: 'resumed', lastAccountedMessageID: 'old' };
    expect(decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 5, 'cancelled')])).kind)
      .toBe('continue');
    expect(decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 5)])).kind)
      .toBe('continue');
    expect(decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 5, 'failed')])).goal.status)
      .toBe('blocked');
    expect(decideNnaGoalEvidence({ ...goal, tokensUsed: 100 }, sessionId,
      feed([receipt('old', 5)])).goal.status).toBe('budgetLimited');
    expect(decideNnaGoalEvidence({ ...goal, turnsUsed: 20 }, sessionId,
      feed([receipt('old', 5)])).goal.status).toBe('blocked');
    expect(decideNnaGoalEvidence({ ...base(), statusReason: 'resumed' }, sessionId,
      feed([])).kind).toBe('wait');
  });

  it('fails closed on a missing cursor, even if the feed reports untruncated', () => {
    const goal = { ...base(), lastAccountedMessageID: 'gone' };
    const result = decideNnaGoalEvidence(goal, sessionId, feed([receipt('later', 5)]));
    expect(result.goal.status).toBe('blocked');
    expect(result.goal.statusReason).toBe('goal turn evidence cursor missing');
    expect(result.goal.lastAccountedMessageID).toBe('gone');
  });

  it('accepts a truncated feed only when the cursor is still present', () => {
    expect(decideNnaGoalEvidence(base(), sessionId, feed([receipt('new', 5)], true)).goal.status).toBe('blocked');
    const goal = { ...base(), lastAccountedMessageID: 'old' };
    expect(decideNnaGoalEvidence(goal, sessionId, feed([receipt('old', 2), receipt('new', 5)], true)).kind).toBe('audit');
  });

  it('rejects unknown usage, numeric overflow, and malformed feed without advancing', () => {
    const unknown = decideNnaGoalEvidence(base(), sessionId, feed([receipt('new', null)]));
    expect(unknown.goal.statusReason).toBe('goal token usage unavailable');
    expect(unknown.goal.lastAccountedMessageID).toBe('');
    expect(decideNnaGoalEvidence({ ...base(), tokensUsed: Number.MAX_SAFE_INTEGER }, sessionId,
      feed([receipt('new', 1)])).goal.statusReason).toBe('goal token usage unavailable');
    const malformed = feed([receipt('same', 1), receipt('same', 2)]);
    expect(decideNnaGoalEvidence(base(), sessionId, malformed).goal.statusReason).toBe('goal turn evidence unavailable');
    expect(decideNnaGoalEvidence(base(), sessionId, { ...feed([]), session_id: 'other' }).goal.status)
      .toBe('blocked');
  });
});
