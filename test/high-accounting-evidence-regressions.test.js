// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureContextCompression } from '../src/reliability/context-compression.js';
import { projectDuplicateToolResults } from '../src/reliability/duplicate-results.js';
import { ProcessIdentity } from '../src/reliability/process-identity.js';
import { measureProviderEnvelope, createProviderTokenReceipt, aggregateTokenReceipts, combineTokenAccounting } from '../src/reliability/token-accounting.js';
import { attachProviderRequestMetadata } from '../src/provider/request-metadata.js';
import { recentReviewEvidence } from '../src/review-evidence.js';
import { StructuredLog } from '../src/structured-log.js';

test('tokenizer failure is explicit even when its identity mimics the fallback', () => {
  let calls = 0;
  const result = measureContextCompression([{ content: 'before' }], [{ content: 'after' }], {
    tokenizerIdentity: 'conservative_utf8_v2', tokenizerExact: true,
    tokenCounter() { if (++calls === 1) return 10000; throw Object.assign(new Error('broken'), { code: 'TOKENIZER_FAILED' }); },
  });
  assert.equal(result.tokenizer.degraded, true); assert.equal(result.tokenizer.exact, false);
  assert.ok(result.before_tokens < 10000); assert.equal(result.tokenizer.failure_code, 'TOKENIZER_FAILED');
});
test('invalid compression input does not escape as a raw fallback TypeError', () => {
  for (const value of [{}, null, [null]]) assert.throws(() => measureContextCompression(value, []), { code: 'context_compression_invalid' });
});
test('duplicate savings already measure the complete projected record', () => {
  const record = { type: 'tool_result', toolLifecycleStatus: 'succeeded', content: 'hello'.repeat(2000), metadata: { fixture: 'x' }, output: 'y'.repeat(1000) };
  const records = [{ ...record, requestId: 'first' }, { ...record, requestId: 'second' }];
  const result = projectDuplicateToolResults(records);
  assert.equal(result.duplicateRecords, 1);
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  assert.equal(result.bytesSaved, bytes(records[0]) - bytes(result.records[0]));
  assert.equal(projectDuplicateToolResults(records, new Set(), { minimumSavingsBytes: result.bytesSaved + 1 }).duplicateRecords, 0);
});
test('self identity retries a failed probe but caches a successful one', async () => {
  let count = 0;
  const identity = new ProcessIdentity({ platform: 'regression-fixture', kill() {}, runProbe: async () => { if (++count === 1) throw new Error('transient'); return 'started'; } });
  assert.equal((await identity.capture(process.pid)).start_id, null);
  assert.equal((await identity.capture(process.pid)).start_id, 'started');
  await identity.capture(process.pid); assert.equal(count, 2);
});
test('missing or inconsistent injection metadata cannot invent section provenance', () => {
  const context = [{ role: 'system', content: 'identity', provenance: 'identity' }, { role: 'user', content: 'hello', provenance: 'user' }];
  const request = { messages: [context[0], { role: 'system', content: 'injected' }, context[1]], tools: [] };
  for (const attach of [false, true]) {
    if (attach) attachProviderRequestMetadata(request, { injectedMessageIndexes: [] });
    const envelope = measureProviderEnvelope(request, context);
    assert.equal(envelope.provenance_status, 'unavailable');
    assert.ok(envelope.sections.some((section) => section.id === 'request.unattributed'));
  }
});
test('total-only usage has an estimated split that reconciles to the provider total', () => {
  const receipt = createProviderTokenReceipt({ envelope: { estimated_input_tokens: 90 } }, {}, { outputBytes: 30, usage: { total_tokens: 50 } });
  assert.equal(receipt.accounting.measurement, 'mixed');
  assert.equal(receipt.accounting.accounted_input_tokens + receipt.accounting.accounted_output_tokens, 50);
  assert.equal(receipt.accounting.component_measurement, 'estimated');
  const total = aggregateTokenReceipts([receipt]); assert.equal(total.accounted_total_tokens, 50);
  assert.equal(combineTokenAccounting([total]).measurement, 'mixed');
});
test('legacy null request IDs survive evidence selection and trusted log context wins', () => {
  assert.equal(recentReviewEvidence([{ type: 'tool_result', requestId: null, content: 'observed' }]).length, 1);
  const log = new StructuredLog();
  assert.equal(log.record({ type: 'event', session_id: 'untrusted' }, { sessionId: 'trusted' }).session_id, 'trusted');
});
