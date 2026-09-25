// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { nndGoalEvidence, nndGoalTurnReceipt, recordNndGoalTurn } from '../src/nnd-goal-evidence.js';
import { NndEngineHost } from '../src/nnd-engine-host.js';

test('goal receipts project only bounded accounting and durable outcome fields', () => {
  const receipt = nndGoalTurnReceipt({ type: 'turn_result', request_id: 'msg_0001', outcome: 'completed',
    text: 'private answer', failure: { secret: 'private' }, usage: { total_tokens: 37 },
    token_accounting: { accounted_total_tokens: 42, measurement: 'mixed', by_role: { reviewer: { secret: 'private' } } } });
  assert.deepEqual(receipt, { request_id: 'msg_0001', outcome: 'completed', tokens: 42, measurement: 'mixed' });
  assert.equal(nndGoalTurnReceipt({ type: 'turn_result', request_id: '../escape' }), null);
  assert.equal(nndGoalTurnReceipt({ type: 'turn_result', request_id: 'goal.turn:1' })?.request_id, 'goal.turn:1');
  assert.deepEqual(nndGoalTurnReceipt({ type: 'turn_outcome', request_id: 'msg_0002', outcome: 'failed' }), {
    request_id: 'msg_0002', outcome: 'failed', tokens: null, measurement: 'unavailable',
  });
  assert.deepEqual(nndGoalTurnReceipt({ type: 'turn_result', request_id: 'msg_0003', outcome: 'completed',
    usage: { total_tokens: 18 }, token_accounting: { accounted_total_tokens: 0, measurement: 'unavailable' } }), {
    request_id: 'msg_0003', outcome: 'completed', tokens: 18, measurement: 'provider',
  });
});

test('goal evidence preserves journal order and de-duplicates live completion after restart', () => {
  const context = { goalTurnReceipts: [] };
  recordNndGoalTurn(context, { type: 'turn_result', request_id: 'msg_0002', outcome: 'completed', usage: { total_tokens: 4 } });
  const journal = [{ type: 'turn_outcome', request_id: 'msg_0001', outcome: 'completed', usage: { total_tokens: 3 } },
    { type: 'message', role: 'assistant', content: 'private' }];
  assert.deepEqual(nndGoalEvidence('ses_test', journal, context.goalTurnReceipts), {
    session_id: 'ses_test', turns: [
      { request_id: 'msg_0001', outcome: 'completed', tokens: 3, measurement: 'provider' },
      { request_id: 'msg_0002', outcome: 'completed', tokens: 4, measurement: 'provider' },
    ], latest_request_id: 'msg_0002', window_truncated: false,
  });
  const restored = [...journal, { type: 'turn_outcome', request_id: 'msg_0002', outcome: 'completed', usage: { total_tokens: 4 } }];
  assert.equal(nndGoalEvidence('ses_test', restored, context.goalTurnReceipts).turns.length, 2);
});

test('goal evidence caps the live window without exposing a growing unbounded list', () => {
  const context = { goalTurnReceipts: [] };
  for (let index = 0; index < 205; index++) recordNndGoalTurn(context, {
    type: 'turn_result', request_id: `msg_${String(index).padStart(4, '0')}`, outcome: 'completed',
    token_accounting: { accounted_total_tokens: 1, measurement: 'estimated' },
  });
  const evidence = nndGoalEvidence('ses_test', [], context.goalTurnReceipts, context.goalTurnReceiptsTruncated);
  assert.equal(evidence.turns.length, 200);
  assert.equal(evidence.turns[0].request_id, 'msg_0005');
  assert.equal(evidence.latest_request_id, 'msg_0204');
  assert.equal(evidence.window_truncated, true);
});

test('compaction marks evidence incomplete even when no retained turn receipt remains', () => {
  const evidence = nndGoalEvidence('ses_test', [{ type: 'compaction', summary: 'private' }]);
  assert.equal(evidence.latest_request_id, null);
  assert.equal(evidence.window_truncated, true);
  assert.equal(nndGoalEvidence('ses_test', [], [], true).window_truncated, true,
    'a truncated restored journal must also be signaled when the tail has no compaction marker');
});

test('new-goal arming rejects an active turn and fences prompts during catalog persistence', async () => {
  const engine = { config: { workspaceRoot: '/work' }, transcript: [], active: null,
    async initialize() {}, async shutdown() {} };
  let hold = false;
  let release;
  const host = new NndEngineHost({ catalogPath: 'test-goal-arming', createEngine: async () => engine,
    persistCatalog: async () => { if (hold) await new Promise((resolve) => { release = resolve; }); } });
  const owner = { subjectId: 'owner', workspaceIds: ['workspace'] };
  await host.create('ses_goal_arming', owner);
  const now = Date.now();
  const goal = { id: 'goal_arming', objective: 'Do work', objectiveFile: false, status: 'active',
    tokenBudget: null, tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '', evaluationProviderID: '',
    evaluationModelID: '', lastAccountedMessageID: '', createdAt: now, updatedAt: now };
  engine.active = { finalized: false };
  await assert.rejects(host.setGoal('ses_goal_arming', owner, goal, null, 0), (error) => error.code === 'nnd_goal_conflict');
  engine.active = null;
  hold = true;
  const arming = host.setGoal('ses_goal_arming', owner, goal, null, 0);
  for (let index = 0; !release && index < 50; index++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(typeof release, 'function');
  assert.deepEqual(host.submitAsync('ses_goal_arming', { request_id: 'pre_goal', content: 'work' }, owner),
    { accepted: false, reason: 'busy' });
  release();
  assert.equal((await arming).goal.id, goal.id);
  await host.shutdown();
});
