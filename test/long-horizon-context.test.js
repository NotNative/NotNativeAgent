// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_HORIZON_POLICY, longHorizonCompressionTrigger, retainedRecordsFingerprint,
} from '../src/long-horizon-context.js';

test('completed-turn interval initiates long-horizon compression at its bounded threshold', () => {
  const records = Array.from({ length: LONG_HORIZON_POLICY.completedTurns }, (_, index) => ({
    type: 'message', role: 'user', turnId: `turn-${index}`, content: `request ${index}`,
  }));
  const trigger = longHorizonCompressionTrigger(records, { activeTurnId: 'active', effectiveInputTokens: 262_144 });
  assert.equal(trigger.reason, 'completed_turn_interval');
  assert.equal(trigger.completedTurns, LONG_HORIZON_POLICY.completedTurns);
  assert.equal(longHorizonCompressionTrigger(records.slice(1), {
    activeTurnId: 'active', effectiveInputTokens: 262_144,
  }), null);
});

test('historical tool payload budget scales with the effective model input window', () => {
  const records = [{ type: 'tool_result', content: 'x'.repeat(4_100), status: 'succeeded' }];
  const trigger = longHorizonCompressionTrigger(records, { effectiveInputTokens: 10_000 });
  assert.equal(trigger.reason, 'tool_payload_budget');
  assert.equal(trigger.inputBytes, 40_000);
  assert.equal(longHorizonCompressionTrigger(records, { effectiveInputTokens: 20_000 }), null);
});

test('tool payload pressure measures structured content and rejects cycles explicitly', () => {
  const records = [{ type: 'tool_result', content: { text: 'x'.repeat(5_000) } }];
  assert.equal(longHorizonCompressionTrigger(records, { effectiveInputTokens: 10_000 })?.reason, 'tool_payload_budget');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => retainedRecordsFingerprint([cyclic]), { code: 'long_horizon_records_invalid' });
});

test('unknown context capacity does not turn an empty payload into a compression trigger', () => {
  assert.equal(longHorizonCompressionTrigger([
    { type: 'message', role: 'user', turnId: 'active', content: 'hello' },
  ], { activeTurnId: 'active', effectiveInputTokens: null }), null);
});

test('checkpoint integrity drift initiates repair but legacy checkpoints remain compatible', () => {
  const retainedRecords = [{ type: 'message', role: 'user', content: 'retained' }];
  const valid = {
    type: 'compaction', retainedRecords,
    projection: { retainedFingerprint: retainedRecordsFingerprint(retainedRecords) },
  };
  assert.equal(longHorizonCompressionTrigger([valid], { effectiveInputTokens: 10_000 }), null);
  const drifted = { ...valid, retainedRecords: [{ ...retainedRecords[0], content: 'drifted' }] };
  assert.equal(longHorizonCompressionTrigger([drifted], { effectiveInputTokens: 10_000 }).reason, 'stale_continuation_artifact');
  assert.equal(longHorizonCompressionTrigger([{
    type: 'compaction', retainedRecords,
  }], { effectiveInputTokens: 10_000 }), null);
});

test('only records after the latest checkpoint contribute to interval and payload triggers', () => {
  const old = Array.from({ length: 20 }, (_, index) => ({
    type: 'message', role: 'user', turnId: `old-${index}`, content: 'old',
  }));
  const retainedRecords = [{ type: 'message', role: 'user', turnId: 'retained', content: 'retained' }];
  const checkpoint = {
    type: 'compaction', retainedRecords,
    projection: { retainedFingerprint: retainedRecordsFingerprint(retainedRecords) },
  };
  assert.equal(longHorizonCompressionTrigger([...old, checkpoint, {
    type: 'message', role: 'user', turnId: 'new', content: 'new',
  }], { effectiveInputTokens: 10_000 }), null);
});
