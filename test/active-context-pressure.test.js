// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_PRESSURE, contextPressurePolicy, pressureTier, projectActiveTurn,
} from '../src/reliability/context-pressure.js';
import { buildContext } from '../src/context.js';

test('active pressure tiers use conservative local-model boundaries', () => {
  assert.deepEqual(CONTEXT_PRESSURE, {
    receipts: 0.40, checkpoint: 0.55, aggressive: 0.70, compact: 0.75,
  });
  assert.equal(pressureTier(39_999, 100_000), 'none');
  assert.equal(pressureTier(40_000, 100_000), 'receipts');
  assert.equal(pressureTier(55_000, 100_000), 'checkpoint');
  assert.equal(pressureTier(70_000, 100_000), 'aggressive');
  assert.equal(pressureTier(75_000, 100_000), 'compact');
});

test('active pressure policy honors all four configured boundaries', () => {
  const policy = contextPressurePolicy(0.35, 0.48, 0.62, 0.72);
  assert.equal(pressureTier(34_999, 100_000, policy), 'none');
  assert.equal(pressureTier(35_000, 100_000, policy), 'receipts');
  assert.equal(pressureTier(48_000, 100_000, policy), 'checkpoint');
  assert.equal(pressureTier(62_000, 100_000, policy), 'aggressive');
  assert.equal(pressureTier(72_000, 100_000, policy), 'compact');
});

test('receipt pressure keeps recent steps and replaces settled payloads without mutating the ledger', () => {
  const records = fixture();
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  assert.equal(projected.tier, 'receipts');
  assert.equal(projected.records.length, records.length);
  assert.equal(JSON.parse(projected.records[2].content).schema, 'nna.tool-receipt.v2');
  assert.ok(Buffer.byteLength(projected.records[2].content, 'utf8') > 4_000);
  assert.equal(records[2].content, 'old result '.repeat(1_000));
  assert.equal(projected.records.find((item) => item.providerCallId === 'call-4' && item.type === 'tool_result').content, 'latest result');
  assert.ok(projected.evidenceRetention.sourceToolResultBytes > projected.evidenceRetention.projectedToolResultBytes);
});

test('receipt pressure reports true original and omitted tool-result bytes to the provider', () => {
  const records = fixture();
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  const result = projected.records.find((item) => item.providerCallId === 'call-1' && item.type === 'tool_result');
  const originalBytes = Buffer.byteLength(records[2].content, 'utf8');
  assert.equal(result.metadata.originalBytes, originalBytes);
  const context = buildContext({
    workspaceRoot: process.cwd(), limits: { maxContextBytes: 1_048_576 }, executionManifest: null,
  }, projected.records, 'Continue.');
  const envelope = JSON.parse(context.find((item) => item.role === 'tool').content);
  assert.equal(envelope.projection_metadata.original_bytes, originalBytes);
  assert.equal(envelope.projection_metadata.omitted_bytes,
    originalBytes - envelope.projection_metadata.retained_source_bytes);
  assert.ok(envelope.projection_metadata.omitted_bytes > 0);
});

test('receipt pressure preserves schema-valid native tool request arguments exactly', () => {
  const records = fixture();
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  const request = projected.records.find((item) => item.providerCallId === 'call-1' && item.type === 'tool_request');
  assert.strictEqual(request, records[1]);
  assert.deepEqual(request.args, { path: 'old.txt' });
  assert.equal(Object.hasOwn(request.args, 'compacted'), false);
  assert.equal(Object.hasOwn(request.args, 'target'), false);
  assert.equal(Object.hasOwn(request.args, 'ledgerRef'), false);
});

test('compression projects completed turns so older history cannot bypass every tier', () => {
  // Regression: only the active turn was compressed, so a long session reached
  // compaction with its bulk still intact.
  const records = [
    { type: 'message', role: 'user', turnId: 'turn-old-1', content: 'first request' },
    { type: 'message', role: 'assistant', turnId: 'turn-old-1', stepId: 'o1-s1', content: 'first answer with a long explanation' },
    { type: 'tool_request', turnId: 'turn-old-1', stepId: 'o1-s1', requestId: 'r-o1', providerCallId: 'c-o1', toolName: 'fs_read', args: { path: 'old.txt' } },
    { type: 'tool_result', turnId: 'turn-old-1', stepId: 'o1-s1', requestId: 'r-o1', providerCallId: 'c-o1', toolName: 'fs_read', toolLifecycleStatus: 'succeeded', content: 'x'.repeat(4_000) },
    { type: 'message', role: 'user', turnId: 'turn-now', content: 'current request' },
    { type: 'message', role: 'assistant', turnId: 'turn-now', stepId: 'n-s1', content: 'current step' },
  ];
  const projected = projectActiveTurn(records, { turnId: 'turn-now', stepId: 'n-s1', tier: 'receipts' });
  // The completed turn is demoted, not passed through untouched.
  assert.notStrictEqual(projected.records[3], records[3]);
  assert.match(projected.records[3].content, /excerpt|omitted|ledger/u);
  // The newest active turn stays hot.
  assert.strictEqual(projected.records[5], records[5]);
  assert.equal(projected.records[1].content.startsWith('first answer'), true, 'assistant prose is bounded, not discarded');
});

test('aggressive pressure removes more than checkpoint pressure', () => {
  const records = [
    { type: 'message', role: 'user', turnId: 'turn-old', content: 'older objective' },
    { type: 'message', role: 'assistant', turnId: 'turn-old', stepId: 'o-s1', content: 'older assistant prose that is long enough to matter '.repeat(20) },
    { type: 'tool_request', turnId: 'turn-old', stepId: 'o-s1', requestId: 'r-1', providerCallId: 'c-1', toolName: 'fs_read', args: { path: 'a.txt' } },
    { type: 'tool_result', turnId: 'turn-old', stepId: 'o-s1', requestId: 'r-1', providerCallId: 'c-1', toolName: 'fs_read', toolLifecycleStatus: 'succeeded', content: 'y'.repeat(3_000) },
    { type: 'message', role: 'user', turnId: 'turn-now', content: 'continue' },
    { type: 'message', role: 'assistant', turnId: 'turn-now', stepId: 'n-s1', content: 'working on the release gate '.repeat(30) },
    { type: 'message', role: 'assistant', turnId: 'turn-now', stepId: 'n-s2', content: 'latest step result' },
    { type: 'message', role: 'user', turnId: 'turn-fresh', content: 'next request' },
    { type: 'message', role: 'assistant', turnId: 'turn-fresh', stepId: 'f-s1', content: 'next answer' },
  ];
  const bytes = (items) => Buffer.byteLength(JSON.stringify(items), 'utf8');
  const tiers = ['receipts', 'checkpoint', 'aggressive']
    .map((tier) => ({ tier, size: bytes(projectActiveTurn(records, { turnId: 'turn-fresh', tier }).records) }));
  // Invariant: a higher measured tier never leaves a larger context than a lower one.
  assert.ok(tiers[1].size < tiers[0].size, `${tiers[1].tier} must be smaller than ${tiers[0].tier}`);
  assert.ok(tiers[2].size < tiers[1].size, `${tiers[2].tier} must be smaller than ${tiers[1].tier}`);
  const aggressive = projectActiveTurn(records, { turnId: 'turn-fresh', tier: 'aggressive' });
  assert.equal(aggressive.records.at(-1).content, records.at(-1).content, 'the newest assistant message stays exact');
  assert.ok(aggressive.records.some((item) => item.type === 'context_checkpoint'), 'the checkpoint carries the dropped evidence');
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

test('active pressure truncation preserves complete UTF-8 characters', () => {
  const records = fixture();
  records[2] = { ...records[2], content: '界'.repeat(2_000) };
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  assert.equal(projected.records[2].content.includes('\uFFFD'), false);
  assert.match(JSON.parse(projected.records[2].content).excerpt, /middle omitted/u);
});

test('receipt pressure identifies duplicate cold results across different tool requests', () => {
  const repeated = `shared evidence ${'x'.repeat(5_000)}`;
  const records = [
    { type: 'message', role: 'user', content: 'compare evidence', turnId: 'turn-1' },
    { type: 'tool_request', toolName: 'fs_read_text', args: { path: 'a.txt' }, providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_result', toolName: 'fs_read_text', content: repeated, status: 'succeeded', providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'message', role: 'assistant', content: 'Compare another source.', turnId: 'turn-1', stepId: 'step-2' },
    { type: 'message', role: 'assistant', content: 'One more comparison.', turnId: 'turn-1', stepId: 'step-3' },
    { type: 'tool_request', toolName: 'web_fetch', args: { url: 'https://example.invalid/a' }, providerCallId: 'call-2', requestId: 'req-2', turnId: 'turn-1', stepId: 'step-4' },
    { type: 'tool_result', toolName: 'web_fetch', content: repeated, status: 'succeeded', providerCallId: 'call-2', requestId: 'req-2', turnId: 'turn-1', stepId: 'step-4' },
  ];
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'receipts' });
  const receipt = JSON.parse(projected.records[2].content);
  assert.equal(receipt.schema, 'nna.duplicate-result-receipt.v1');
  assert.equal(receipt.duplicate_of.ledger_ref, 'req-2');
  assert.equal(projected.records[6].content, repeated);
  assert.equal(projected.duplicateResultRecords, 1);
  assert.ok(projected.duplicateResultBytesSaved > 4_000);
  assert.equal(records[2].content, repeated);
});

test('active pressure measures repeated exact reads without retaining request content in telemetry', () => {
  const records = fixture();
  records.splice(4, 0,
    { type: 'tool_request', toolName: 'fs_read_text', args: { path: 'old.txt' }, providerCallId: 'call-repeat', requestId: 'req-repeat', turnId: 'turn-1', stepId: 'step-2' },
    { type: 'tool_result', toolName: 'fs_read_text', content: 'recovered evidence', status: 'succeeded', providerCallId: 'call-repeat', requestId: 'req-repeat', turnId: 'turn-1', stepId: 'step-2' });
  const projected = projectActiveTurn(records, { turnId: 'turn-1', stepId: 'step-4', tier: 'checkpoint' });
  assert.equal(projected.evidenceRetention.repeatedReadRequests, 1);
  assert.ok(projected.evidenceRetention.sourceToolResultBytes > 0);
  assert.ok(projected.evidenceRetention.checkpointBytes > 0);
  assert.equal(Object.hasOwn(projected.evidenceRetention, 'path'), false);
});

function fixture() {
  return [
    { type: 'message', role: 'user', content: 'inspect the project', turnId: 'turn-1' },
    { type: 'tool_request', toolName: 'fs_read_text', args: { path: 'old.txt' }, providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_result', toolName: 'fs_read_text', content: 'old result '.repeat(1_000), status: 'succeeded', providerCallId: 'call-1', requestId: 'req-1', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'message', role: 'assistant', content: 'Old finding', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'message', role: 'assistant', content: 'Second finding', turnId: 'turn-1', stepId: 'step-2' },
    { type: 'message', role: 'assistant', content: 'Third finding', turnId: 'turn-1', stepId: 'step-3' },
    { type: 'tool_request', toolName: 'fs_read_text', args: { path: 'latest.txt' }, providerCallId: 'call-4', requestId: 'req-4', turnId: 'turn-1', stepId: 'step-4' },
    { type: 'tool_result', toolName: 'fs_read_text', content: 'latest result', status: 'succeeded', providerCallId: 'call-4', requestId: 'req-4', turnId: 'turn-1', stepId: 'step-4' },
    { type: 'message', role: 'assistant', content: 'Unrelated prior turn', turnId: 'turn-0', stepId: 'prior-step' },
  ];
}
