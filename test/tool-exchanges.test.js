// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolExchanges } from '../src/reliability/tool-exchanges.js';
import { compactTranscript } from '../src/reliability/compaction.js';
import { projectActiveTurn } from '../src/reliability/context-pressure.js';

function exchange(id, providerCallId, turnId = 'turn') {
  return [
    { type: 'tool_request', requestId: id, providerCallId, turnId, toolName: 'fs_read', args: { path: id } },
    { type: 'tool_result', requestId: id, providerCallId, turnId, toolName: 'fs_read', status: 'succeeded', content: `${id}:${'x'.repeat(6000)}` },
  ];
}

test('compaction retains separate missing-call-id exchanges and their exact targets', () => {
  for (const missing of [null, undefined, '']) {
    const records = [...exchange('first', missing), ...exchange('second', missing)];
    const original = structuredClone(records);
    const compacted = compactTranscript(records, 1_000_000, { activeTurnId: 'turn' });
    assert.deepEqual(compacted.records.filter((r) => r.type === 'tool_result').map((r) => r.requestId), ['first', 'second']);
    assert.deepEqual(compacted.fact.continuation.verifiedFacts, ['fs_read completed successfully', 'fs_read completed successfully']);
    assert.deepEqual(records, original);
    const cold = compactTranscript(records, 1_000_000, { protectedCompletedTurns: 0 });
    assert.equal(cold.fact.projection.supersededRecords, 0);
    assert.deepEqual(cold.records.filter((r) => r.type === 'tool_result').map((r) => JSON.parse(r.content).target), ['first', 'second']);
  }
});

test('ambiguous exchanges are retained independently and never declare a mutation successful', () => {
  const records = [...exchange(null, null), ...exchange(null, null)];
  records[0].toolName = 'fs_write_text'; records[2].toolName = 'fs_write_text';
  const compacted = compactTranscript(records, 1_000_000, { protectedCompletedTurns: 0 });
  assert.equal(compacted.records.length, records.length);
  assert.deepEqual(compacted.records, records);
  assert.ok(compacted.fact.continuation.changedFiles.every((file) => file.toolLifecycleStatus === 'unresolved'));
  assert.equal(compacted.fact.continuation.verifiedFacts.length, 0);
});

test('reused call ids cannot cross turns or override a distinct lifecycle identity', () => {
  const records = [...exchange('a', 'reused'), ...exchange('b', 'reused'), ...exchange('c', 'reused', 'other')];
  const pairs = toolExchanges(records);
  assert.equal(pairs.requests.get(records[1]), records[0]);
  assert.equal(pairs.requests.get(records[3]), records[2]);
  assert.equal(pairs.requests.get(records[5]), records[4]);
  records[3].requestId = 'wrong';
  assert.equal(toolExchanges(records).requests.has(records[3]), false);
});

test('duplicate identities, reversed results and canceled outcomes do not fabricate completion', () => {
  const duplicate = [...exchange(null, 'same'), ...exchange(null, 'same')];
  assert.equal(toolExchanges(duplicate).partners.size, 0);
  const [request, result] = exchange('cancel', 'call');
  result.status = 'cancelled';
  assert.equal(toolExchanges([result, request]).partners.size, 0);
  const compacted = compactTranscript([request, result], 1_000_000, { activeTurnId: 'turn' });
  assert.equal(compacted.records[1].status, 'cancelled');
  assert.equal(compacted.fact.continuation.verifiedFacts.length, 0);
});

test('active-turn receipts resolve missing call ids by lifecycle id without target contamination', () => {
  const records = [...exchange('a', null), ...exchange('b', null),
    { type: 'message', role: 'assistant', turnId: 'turn', stepId: 'hot', content: 'continue' }];
  const projection = projectActiveTurn(records, { turnId: 'turn', tier: 'receipts' });
  assert.deepEqual(projection.records.filter((r) => r.type === 'tool_result').map((r) => JSON.parse(r.content).target), ['a', 'b']);
});
