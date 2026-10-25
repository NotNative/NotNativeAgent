// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_HORIZON_POLICY, longHorizonCompressionTrigger, retainedRecordsFingerprint,
} from '../src/reliability/long-horizon-context.js';

test('completed-turn interval initiates long-horizon compression at its bounded threshold', () => {
  const records = Array.from({ length: LONG_HORIZON_POLICY.completedTurns }, (_, index) => ({
    type: 'message', role: 'user', turnId: `turn-${index}`, content: `request ${index}`,
  }));
  const trigger = longHorizonCompressionTrigger(records, { activeTurnId: 'active', effectiveInputTokens: 262_144,
    estimatedInputTokens: 110000 });
  assert.equal(trigger.reason, 'completed_turn_interval');
  assert.equal(trigger.completedTurns, LONG_HORIZON_POLICY.completedTurns);
  assert.equal(longHorizonCompressionTrigger(records.slice(1), {
    activeTurnId: 'active', effectiveInputTokens: 262_144,
  }), null);
});

test('turn cadence alone cannot compact a small conversation on a large-window model', () => {
  const records = Array.from({ length: 40 }, (_, index) => ({ type: 'message', role: 'user', turnId: `turn-${index}`, content: 'Hello.' }));
  assert.equal(longHorizonCompressionTrigger(records, { effectiveInputTokens: 268000, estimatedInputTokens: 8000 }), null);
  assert.equal(longHorizonCompressionTrigger(records, { effectiveInputTokens: 268000 }), null);
});

test('tool payload size alone never initiates compression on a large window', () => {
  // Regression: a 20 KB `git_inspect` result on a 1M-token model measured well
  // under 1% of usable input yet used to trigger a rewrite of the live turn.
  const records = [
    { type: 'message', role: 'user', turnId: 'active', content: 'Report the build status.' },
    { type: 'tool_result', turnId: 'active', content: 'x'.repeat(20_977), status: 'succeeded' },
  ];
  assert.equal(longHorizonCompressionTrigger(records, {
    activeTurnId: 'active', effectiveInputTokens: 1_018_576, estimatedInputTokens: 7_100,
  }), null);
  assert.equal(longHorizonCompressionTrigger(records, {
    activeTurnId: 'active', effectiveInputTokens: 1_018_576, estimatedInputTokens: 100_000,
  }), null);
});

test('a large tool payload only compresses once measured input crosses the window share', () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    type: 'message', role: 'user', turnId: `turn-${index}`, content: 'x'.repeat(1_500),
  }));
  const trigger = longHorizonCompressionTrigger(records, {
    effectiveInputTokens: 262_144, estimatedInputTokens: 110_000,
  });
  assert.equal(trigger.reason, 'completed_turn_interval');
  assert.equal(longHorizonCompressionTrigger(records, {
    effectiveInputTokens: 262_144, estimatedInputTokens: 60_000,
  }), null);
});

test('tool payload pressure rejects cycles explicitly without inventing a trigger', () => {
  const records = [{ type: 'tool_result', content: { text: 'x'.repeat(5_000) } }];
  assert.equal(longHorizonCompressionTrigger(records, { effectiveInputTokens: 10_000 }), null);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => retainedRecordsFingerprint([cyclic]), { code: 'long_horizon_records_invalid' });
});

test('structured tool payloads stay below the window share they consume', () => {
  assert.equal(longHorizonCompressionTrigger([{ type: 'tool_result', content: { text: 'x'.repeat(5_000) } }], {
    effectiveInputTokens: 1_000_000, estimatedInputTokens: 2_000,
  }), null);
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
