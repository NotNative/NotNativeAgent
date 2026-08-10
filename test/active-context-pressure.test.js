// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_PRESSURE, pressureTier, projectActiveTurn } from '../src/active-context-pressure.js';

test('active pressure tiers use conservative local-model boundaries', () => {
  assert.deepEqual(CONTEXT_PRESSURE, {
    receipts: 0.25, checkpoint: 0.35, aggressive: 0.45, compact: 0.60,
  });
  assert.equal(pressureTier(24_999, 100_000), 'none');
  assert.equal(pressureTier(25_000, 100_000), 'receipts');
  assert.equal(pressureTier(35_000, 100_000), 'checkpoint');
  assert.equal(pressureTier(45_000, 100_000), 'aggressive');
  assert.equal(pressureTier(60_000, 100_000), 'compact');
});

test('receipt pressure keeps recent steps and replaces settled payloads without mutating the ledger', () => {
  const records = fixture();
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  assert.equal(projected.tier, 'receipts');
  assert.equal(projected.records.length, records.length);
  assert.match(projected.records[2].content, /durable session journal/u);
  assert.equal(records[2].content, 'old result '.repeat(1_000));
  assert.equal(projected.records.find((item) => item.providerCallId === 'call-4' && item.type === 'tool_result').content, 'latest result');
});

test('checkpoint pressure journals settled work and retains only hot active steps in prompt projection', () => {
  const records = fixture();
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'checkpoint' });
  assert.equal(projected.checkpoint.type, 'context_checkpoint');
  assert.match(projected.checkpoint.summary, /Authenticated objective: inspect the project/u);
  assert.match(projected.checkpoint.summary, /Settled tool receipts/u);
  assert.ok(projected.records.some((item) => item.type === 'context_checkpoint'));
  assert.ok(!projected.records.some((item) => item.stepId === 'step-1'));
  assert.ok(projected.records.some((item) => item.stepId === 'step-3'));
  assert.ok(projected.records.some((item) => item.stepId === 'step-4'));
  assert.equal(records.length, 9, 'the durable source remains unchanged');
});

function fixture() {
  return [
    { type: 'message', role: 'user', content: 'inspect the project', turnId: 'turn-1' },
    { type: 'tool_request', toolName: 'fs.read_text', args: { path: 'old.txt' }, providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_result', toolName: 'fs.read_text', content: 'old result '.repeat(1_000), status: 'succeeded', providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'message', role: 'assistant', content: 'Old finding', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'message', role: 'assistant', content: 'Second finding', turnId: 'turn-1', stepId: 'step-2' },
    { type: 'message', role: 'assistant', content: 'Third finding', turnId: 'turn-1', stepId: 'step-3' },
    { type: 'tool_request', toolName: 'fs.read_text', args: { path: 'latest.txt' }, providerCallId: 'call-4', requestId: 'req-4', turnId: 'turn-1', stepId: 'step-4' },
    { type: 'tool_result', toolName: 'fs.read_text', content: 'latest result', status: 'succeeded', providerCallId: 'call-4', requestId: 'req-4', turnId: 'turn-1', stepId: 'step-4' },
    { type: 'message', role: 'assistant', content: 'Unrelated prior turn', turnId: 'turn-0', stepId: 'prior-step' },
  ];
}
