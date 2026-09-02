// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPRESSION_CLASS, compareCompressionOutcomes, contextCompressionPolicy, measureContextCompression,
} from '../src/reliability/context-compression.js';
import { ReliabilityEngine } from '../src/index.js';

test('compression policy protects authority and classifies only durable settled evidence as recoverable', () => {
  assert.equal(contextCompressionPolicy({ type: 'message', role: 'user' }).class, COMPRESSION_CLASS.protected);
  assert.equal(contextCompressionPolicy({ type: 'message', role: 'system' }).reason, 'system_contract');
  assert.equal(contextCompressionPolicy({}, { kind: 'tool_schema' }).class, COMPRESSION_CLASS.protected);
  assert.equal(contextCompressionPolicy({ type: 'tool_result', status: 'failed' }).class, COMPRESSION_CLASS.protected);
  const settled = contextCompressionPolicy({ type: 'tool_result', status: 'succeeded' });
  assert.equal(settled.class, COMPRESSION_CLASS.recoverable);
  assert.ok(settled.allowedReducers.includes('content_identity_dedup_v1'));
  assert.equal(contextCompressionPolicy({ type: 'message', role: 'assistant' }).class, COMPRESSION_CLASS.semantic);
  assert.equal(contextCompressionPolicy({ type: 'tool_result', status: 'succeeded' }, { active: true }).class, COMPRESSION_CLASS.protected);
});

test('compression measurement reports per-reducer savings and rediscovery-adjusted value', () => {
  const before = [{ role: 'user', content: 'x'.repeat(4_000) }];
  const after = [{ role: 'user', content: 'x'.repeat(400) }];
  const measured = measureContextCompression(before, after, {
    reducers: [{ name: 'fixture', class: 'recoverable', records: 1, bytesSaved: 3_600 }],
    rediscovery: { toolCalls: 1, bytes: 300, estimatedTokens: 100 },
  });
  assert.equal(measured.schema, 'nna.context-compression-measurement.v1');
  assert.ok(measured.bytes_saved > 3_000);
  assert.ok(measured.tokens_saved > 800);
  assert.equal(measured.net_tokens_saved, measured.tokens_saved - 100);
  assert.equal(measured.tokenizer.identity, 'conservative_utf8_v2');
  assert.equal(measured.tokenizer.exact, false);
  assert.deepEqual(measured.reducers[0], {
    name: 'fixture', class: 'recoverable', records: 1, bytes_saved: 3_600,
  });
});

test('optional tokenizer identity is explicit and invalid counters degrade conservatively', () => {
  const exact = measureContextCompression(['one two three'], ['one'], {
    tokenCounter: { identity: 'qwen-fixture-v1', exact: true, count: (records) => records.join(' ').split(/\s+/u).length },
  });
  assert.deepEqual(exact.tokenizer, {
    identity: 'qwen-fixture-v1', requested_identity: 'qwen-fixture-v1', exact: true, degraded: false,
  });
  const degraded = measureContextCompression(['before'], ['after'], {
    tokenCounter: { identity: 'broken-tokenizer', exact: true, count: () => { throw new Error('offline'); } },
  });
  assert.equal(degraded.tokenizer.identity, 'conservative_utf8_v2');
  assert.equal(degraded.tokenizer.requested_identity, 'broken-tokenizer');
  assert.equal(degraded.tokenizer.exact, false);
  assert.equal(degraded.tokenizer.degraded, true);
});

test('outcome equivalence compares completion, tool decisions, and final outcome', () => {
  const baseline = { status: 'succeeded', toolDecisions: [{ tool: 'fs.read_text', target: 'a' }], finalOutcome: { files: ['a'] } };
  assert.equal(compareCompressionOutcomes(baseline, structuredClone(baseline)).equivalent, true);
  const changed = compareCompressionOutcomes(baseline, { ...baseline, toolDecisions: [{ tool: 'fs.write_text', target: 'a' }] });
  assert.equal(changed.equivalent, false);
  assert.equal(changed.dimensions.tool_decisions, false);
});

test('Reliability Engine exposes configured tokenizer measurement without making it a dependency', () => {
  const reliability = new ReliabilityEngine({
    contextTokenCounter: () => 7, contextTokenizerIdentity: 'qwen-runtime-fixture', contextTokenizerExact: true,
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });
  const measured = reliability.measureContextCompression([{ content: 'before' }], [{ content: 'after' }]);
  assert.equal(measured.before_tokens, 7);
  assert.equal(measured.after_tokens, 7);
  assert.equal(measured.tokenizer.identity, 'qwen-runtime-fixture');
  assert.equal(reliability.health().context_compression_measurement, true);
});
