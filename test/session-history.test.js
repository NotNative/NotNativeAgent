// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreSessionRecords } from '../src/persistence/session-history.js';
import { transcriptEvents } from '../src/experience/transcript.js';

test('AC-SESS-02 semantic transcript preserves partial text, tool pairs, compaction, and exact outcome order', () => {
  const records = [
    record('turn_accepted', { turnId: 'turn-1', requestId: 'request-1' }),
    record('message', { type: 'message', role: 'user', content: 'Do work', turnId: 'turn-1' }),
    record('tool_request', { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.read_text', args: { path: 'a' } }),
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
  assert.equal(projection.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(projection.at(-1).outcome, 'cancelled');
  assert.equal(projection.at(-1).failure.code, 'turn_cancelled');
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

function record(type, payload) { return { type, payload }; }
