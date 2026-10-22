// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreSessionRecords } from '../src/persistence/session-history.js';
import { journalEvents, transcriptEvents } from '../src/experience/transcript.js';
import { estimateTokenValue } from '../src/reliability/context-token-measurement.js';
import { compactWorkspaceConversation } from '../src/experience/context.js';

test('AC-SESS-02 semantic transcript preserves partial text, tool pairs, compaction, and exact outcome order', () => {
  const records = [
    record('turn_accepted', { turnId: 'turn-1', requestId: 'request-1' }),
    record('message', { type: 'message', role: 'user', content: 'Do work', turnId: 'turn-1' }),
    record('tool_request', { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs_read_text', args: { path: 'a' } }),
    record('tool_result', { type: 'tool_result', providerCallId: 'call-1', status: 'succeeded', content: 'result' }),
    record('compaction', { type: 'compaction', omitted: 2, summary: 'older records omitted' }),
    record('message', { type: 'message', role: 'assistant', content: 'partial answer', turnId: 'turn-1', partial: true }),
    record('turn_outcome', { turn_id: 'turn-1', request_id: 'request-1', outcome: 'cancelled', partial: true, failure: { code: 'turn_cancelled' } }),
  ];
  const restored = restoreSessionRecords(records);
  assert.deepEqual(restored.transcript.map((item) => item.type), [
    'message', 'tool_request', 'tool_result', 'compaction', 'message', 'turn_outcome',
  ]);
  assert.equal(restored.interrupted.length, 0);
  const projection = transcriptEvents(restored.transcript);
  assert.deepEqual(projection.map((item) => item.type), ['user_input', 'stream_delta', 'turn_result']);
  assert.equal(projection[1].historical_message, true);
  assert.equal(projection.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(projection.at(-1).outcome, 'cancelled');
  assert.equal(projection.at(-1).failure.code, 'turn_cancelled');
});

test('transcript projection rejects malformed records with a stable error', () => {
  assert.throws(() => transcriptEvents([null]), { code: 'transcript_record_invalid' });
  assert.throws(() => transcriptEvents(null), { code: 'transcript_invalid' });
});

test('durable journal projection restores tool activity, checkpoints, and one committed response', () => {
  const records = [
    record('message', { type: 'message', role: 'user', content: 'Inspect it.', turnId: 'turn-1' }),
    record('tool_request', {
      type: 'tool_request', turnId: 'turn-1', requestId: 'request-1',
      providerCallId: 'call-1', toolName: 'fs_read_text', args: { path: 'target.txt' },
    }),
    record('tool_result', {
      type: 'tool_result', turnId: 'turn-1', requestId: 'request-1', providerCallId: 'call-1',
      toolName: 'fs_read_text', status: 'succeeded', effectCertainty: 'known', elapsedMs: 12,
    }),
    record('response_candidate', {
      type: 'response_candidate', role: 'assistant', content: 'Inspection complete.',
      turnId: 'turn-1', stepId: 'step-answer',
    }),
    record('message', {
      type: 'message', role: 'assistant', content: 'Inspection complete.',
      turnId: 'turn-1', stepId: 'step-answer', partial: false,
    }),
    record('compaction', {
      type: 'compaction', retainedRecords: [{ type: 'message' }], summary: 'A bounded continuation.',
      projection: { measurementUnit: 'tokens', originalTokens: 777,
        originalBytes: 3_000, projectedBytes: 1_500, payloadCompactedRecords: 1 },
    }),
    record('turn_outcome', { turn_id: 'turn-1', outcome: 'completed' }),
  ];

  const projected = journalEvents(records);
  assert.deepEqual(projected.map((item) => item.type), [
    'user_input', 'tool_status', 'stream_delta', 'context_compaction_status', 'turn_result',
  ]);
  assert.equal(projected[1].target, 'target.txt');
  assert.equal(projected.filter((item) => item.type === 'stream_delta').length, 1);
  assert.equal(projected[3].before_estimated_tokens, 777);
  assert.equal(projected[3].after_estimated_tokens,
    estimateTokenValue({ type: 'message' }) + estimateTokenValue('A bounded continuation.'));
});

test('journal replay does not invent compaction token counts from byte-only history', () => {
  const [event] = journalEvents([record('compaction', {
    type: 'compaction', retainedRecords: [], summary: 'summary',
    projection: { originalBytes: 30_000, projectedBytes: 6_000 },
  })]);
  assert.equal(event.before_estimated_tokens, null);
  assert.equal(event.after_estimated_tokens, null);
});

test('manual compaction projects token estimates from the token unit instead of byte size', async () => {
  const projected = { contextTokens: 88, contextBytes: 1_000 };
  const events = [];
  const fact = {
    retainedRecords: [], summary: 'short summary',
    projection: { measurementUnit: 'tokens', originalTokens: 91, originalBytes: 9_000, projectedBytes: 1_500 },
  };
  const workspace = {
    projection: { sessions: new Map([['main', projected]]), apply(_id, event) { events.push(event); } },
    sessions: new Map([['main', { id: 'main', engine: { async compactConversation() {
      return { beforeBytes: 9_000, afterBytes: 1_500, retained: 0, reduced: 0, fact };
    } } }]]),
    tabPersistence: { observe() {} }, _savePoolForBroker() {}, _tasksForBroker() {}, onChange() {},
  };
  await compactWorkspaceConversation(workspace, 'main');
  assert.equal(projected.contextBytes, 1_500);
  assert.equal(projected.contextTokens, estimateTokenValue('short summary'));
  assert.equal(events[0].before_estimated_tokens, 91);
  assert.equal(events[0].after_estimated_tokens, projected.contextTokens);
});

test('truncated journal replay seeds display history from a durable compaction snapshot', () => {
  const snapshotMessage = { type: 'message', role: 'user', content: 'Earlier request', turnId: 'turn-1' };
  const projected = journalEvents([
    record('compaction_snapshot', {
      records: [snapshotMessage], fact: { type: 'compaction', retainedRecords: [], projection: {} },
    }),
    record('message', { type: 'message', role: 'assistant', content: 'Later response', turnId: 'turn-2' }),
  ], { truncated: true });
  assert.deepEqual(projected.map((item) => item.type), [
    'user_input', 'context_compaction_status', 'stream_delta',
  ]);
});

test('bounded-tail recovery identifies an authoritative conversation reset', () => {
  const incomplete = restoreSessionRecords([record('authority_intent', { content: 'later', origin: 'operator' })]);
  assert.equal(incomplete.authorityReset, false);
  const reset = restoreSessionRecords([
    record('authority_intent', { content: 'omitted lineage tail', origin: 'operator' }),
    record('conversation_cleared', {}),
    record('authority_intent', { content: 'new lineage', origin: 'operator' }),
  ]);
  assert.equal(reset.authorityReset, true);
  assert.deepEqual(reset.authority.map((item) => item.content), ['new lineage']);
});

test('terminal carry follows the effective durable timeline across clear and revert', () => {
  const first = record('turn_outcome', { turn_id: 'turn-1', outcome: 'blocked', reviewer_completion: { schema: 'nna.reviewer-completion.v1' } });
  const second = record('turn_outcome', { turn_id: 'turn-2', outcome: 'completed' });
  assert.equal(restoreSessionRecords([first, second]).latestTurnOutcome.turn_id, 'turn-2');
  assert.equal(restoreSessionRecords([first, record('conversation_cleared', {})]).latestTurnOutcome, null);
  const hidden = restoreSessionRecords([
    first, second, record('revert_point', { reverted_turn_ids: ['turn-2'] }),
  ]);
  assert.equal(hidden.latestTurnOutcome.turn_id, 'turn-1');
  const restored = restoreSessionRecords([
    first, second, record('revert_point', { reverted_turn_ids: ['turn-2'] }), record('revert_cleared', {}),
  ]);
  assert.equal(restored.latestTurnOutcome.turn_id, 'turn-2');
});

test('revert hides turns restored from a compaction snapshot, including a bounded tail', () => {
  const first = { type: 'message', role: 'user', content: 'keep', turnId: 'turn-1' };
  const second = { type: 'message', role: 'user', content: 'hide', turnId: 'turn-2' };
  const safeFact = { type: 'compaction', summary: 'first turn only' };
  const leakedFact = { type: 'compaction', summary: 'second turn secret' };
  const snapshot = record('compaction_snapshot', { records: [first, safeFact, second], fact: leakedFact });
  const revert = record('revert_point', { reverted_turn_ids: ['turn-2'] });
  for (const options of [undefined, { controlRecords: [revert] }]) {
    const records = options ? [snapshot] : [snapshot, revert];
    const restored = restoreSessionRecords(records, options);
    assert.deepEqual(restored.transcript, [first, safeFact]);
  }
  const direct = restoreSessionRecords([
    record('message', first), record('compaction', safeFact), record('message', second),
    record('compaction', leakedFact), revert,
  ]);
  assert.deepEqual(direct.transcript, [first, safeFact]);
  const later = { type: 'message', role: 'user', content: 'later', turnId: 'turn-3' };
  const laterFact = { type: 'compaction', summary: 'only visible later work' };
  const continued = restoreSessionRecords([
    record('message', first), record('message', second), record('compaction', leakedFact),
    revert, record('message', later), record('compaction', laterFact),
  ]);
  assert.deepEqual(continued.transcript, [first, later, laterFact]);
});

test('clearing one overlapping revert retains turns hidden by another', () => {
  const first = { type: 'message', role: 'user', content: 'first', turnId: 'turn-1' };
  const second = { type: 'message', role: 'user', content: 'second', turnId: 'turn-2' };
  const records = [record('message', first), record('message', second),
    record('revert_point', { reverted_turn_ids: ['turn-1', 'turn-2'] }),
    record('revert_point', { reverted_turn_ids: ['turn-2'] }), record('revert_cleared', {})];
  assert.deepEqual(restoreSessionRecords(records).transcript, []);
});

test('a genesis-anchored control stream owns authority when the transcript tail is truncated', () => {
  const tail = [
    record('authority_intent', { content: 'tail duplicate', origin: 'operator' }),
    record('conversation_cleared', {}),
    record('message', { type: 'message', role: 'user', content: 'post-clear message', turnId: 'turn-2' }),
    record('mission_turn_authorized', { missionId: 'm', turns: 2, toolCalls: 2, authorizedAt: '2026-09-24T00:00:02.000Z' }),
  ];
  const control = [
    record('authority_intent', { content: 'first grant', origin: 'operator' }),
    record('mission_tool_calls_reserved', { missionId: 'm', turns: 1, toolCalls: 2, reservedAt: '2026-09-24T00:00:01.000Z' }),
    record('conversation_cleared', {}),
    record('authority_intent', { content: 'restated grant', origin: 'operator' }),
    record('mission_turn_authorized', { missionId: 'm', turns: 2, toolCalls: 2, authorizedAt: '2026-09-24T00:00:02.000Z' }),
  ];
  const restored = restoreSessionRecords(tail, { controlRecords: control });
  assert.deepEqual(restored.authority.map((item) => item.content), ['restated grant']);
  assert.equal(restored.authorityReset, true);
  assert.equal(restored.missionTurns.length, 2);
  assert.deepEqual(restored.transcript.map((item) => item.content), ['post-clear message']);
});

test('control replay rejects a record that carries no authority meaning', () => {
  assert.throws(
    () => restoreSessionRecords([], { controlRecords: [record('message', { type: 'message', role: 'user', content: 'x' })] }),
    { code: 'session_history_invalid' },
  );
});

test('steering consumption replays message and authority from one durable record', () => {
  const intent = { content: 'Use the second target', origin: 'operator', sequence: 2, kind: 'statement', turnId: 'turn-1', lineageId: 'auth-1', restrictionVersion: 0 };
  const message = { type: 'message', role: 'user', content: intent.content, trust: 'operator', turnId: 'turn-1', steeringId: 'steer-1' };
  const records = [
    record('steering_accepted', { id: 'steer-1', content: intent.content, turnId: 'turn-1' }),
    record('steering_consumed', { id: 'steer-1', message, intent }),
    record('turn_outcome', { turn_id: 'turn-1', outcome: 'completed' }),
  ];
  const restored = restoreSessionRecords(records);
  assert.deepEqual(restored.authority, [intent]);
  assert.equal(restored.steering.length, 0);
  assert.deepEqual(restored.transcript[0], message);
  assert.deepEqual(restoreSessionRecords(records, { controlRecords: [records[1]] }).authority, [intent]);
});

test('late or abandoned steering never becomes a later turn directive', () => {
  const accepted = record('steering_accepted', { id: 'late', content: 'Old direction', turnId: 'turn-1' });
  const terminal = record('turn_outcome', { turn_id: 'turn-1', outcome: 'completed' });
  assert.equal(restoreSessionRecords([terminal, accepted]).steering.length, 0);
  assert.equal(restoreSessionRecords([accepted, terminal]).steering.length, 0);
  assert.equal(restoreSessionRecords([accepted, record('steering_abandoned', { id: 'late', turnId: 'turn-1' })]).steering.length, 0);
  // A bounded tail can retain the late admission after its terminal record
  // falls outside the window; no visible open turn may claim it.
  assert.equal(restoreSessionRecords([accepted, record('message', {
    type: 'message', role: 'assistant', content: 'Later activity', turnId: 'turn-2',
  })]).steering.length, 0);
});

test('complete control replay preserves steering beyond the tail and excludes terminal admissions', () => {
  const accepted = record('steering_accepted', {
    id: 'pending', content: 'Continue with the revised target', principal: 'operator', turnId: 'open-turn',
  });
  const late = record('steering_accepted', { id: 'late', content: 'Too late', turnId: 'closed-turn' });
  const terminal = record('turn_outcome', { turn_id: 'closed-turn', outcome: 'completed' });
  const tail = [record('message', { type: 'message', role: 'assistant', content: 'checkpoint', turnId: 'open-turn' })];
  const restored = restoreSessionRecords(tail, { controlRecords: [accepted, terminal, late] });
  assert.deepEqual(restored.steering, [accepted.payload]);
  assert.deepEqual(restored.missionTurns, []);
  assert.deepEqual(restored.authority, []);
  assert.deepEqual(restoreSessionRecords(tail, {
    controlRecords: [accepted, terminal, late], controlComplete: false,
  }).steering, []);
  assert.deepEqual(restoreSessionRecords(tail, { controlRecords: [accepted, terminal, late,
    record('turn_outcome', { turn_id: 'open-turn', outcome: 'completed' }),
  ] }).steering, []);
  assert.deepEqual(restoreSessionRecords(tail, { controlRecords: [accepted,
    record('steering_abandoned', { id: 'pending', turnId: 'open-turn' }),
  ] }).steering, []);
  assert.deepEqual(restoreSessionRecords(tail, { controlRecords: [accepted,
    record('conversation_cleared', {}),
  ] }).steering, []);
  // An NND revert can leave a hidden interrupted turn outside the bounded tail.
  assert.deepEqual(restoreSessionRecords(tail, { controlRecords: [accepted,
    record('revert_point', { reverted_turn_ids: ['open-turn'] }),
  ] }).steering, []);
  assert.deepEqual(restoreSessionRecords(tail, { controlRecords: [accepted,
    record('revert_point', { reverted_turn_ids: ['open-turn'] }), record('revert_cleared', {}),
  ] }).steering, [accepted.payload]);
});

test('session history restores the newest durable working directory transition', () => {
  const restored = restoreSessionRecords([
    record('workspace_changed', { workspaceRoot: 'D:/first' }),
    record('workspace_changed', { workspaceRoot: 'D:/second' }),
  ]);
  assert.equal(restored.workspaceRoot, 'D:/second');
  assert.throws(
    () => restoreSessionRecords([record('workspace_changed', { workspaceRoot: '' })]),
    { code: 'session_history_invalid' },
  );
});

function record(type, payload) { return { type, payload }; }
