// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreSessionRecords } from '../src/persistence/session-history.js';
import { journalEvents, transcriptEvents } from '../src/experience/transcript.js';

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
      type: 'compaction', retainedRecords: [{ type: 'message' }],
      projection: { originalBytes: 3_000, projectedBytes: 1_500, payloadCompactedRecords: 1 },
    }),
    record('turn_outcome', { turn_id: 'turn-1', outcome: 'completed' }),
  ];

  const projected = journalEvents(records);
  assert.deepEqual(projected.map((item) => item.type), [
    'user_input', 'tool_status', 'stream_delta', 'context_compaction_status', 'turn_result',
  ]);
  assert.equal(projected[1].target, 'target.txt');
  assert.equal(projected.filter((item) => item.type === 'stream_delta').length, 1);
  assert.equal(projected[3].before_estimated_tokens, 1_000);
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
