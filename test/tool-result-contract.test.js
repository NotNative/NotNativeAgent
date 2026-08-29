// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durableToolResultState, toolLifecycleStatus, toolReviewOutcome,
} from '../src/tools/tool-result-contract.js';
import { denialResult } from '../src/tools/governor.js';
import { toolResultRecord } from '../src/engine/records.js';
import { ToolResultCache } from '../src/tools/result-cache.js';
import { buildContext } from '../src/context.js';

test('legacy denial status remains readable as separated lifecycle and review state', () => {
  const legacy = { type: 'tool_result', status: 'hard_deny' };
  assert.equal(toolLifecycleStatus(legacy), 'denied');
  assert.equal(toolReviewOutcome(legacy), 'hard_deny');
  assert.deepEqual(durableToolResultState(legacy), {
    toolLifecycleStatus: 'denied', reviewOutcome: 'hard_deny',
  });
});

test('new denial results separate tool lifecycle status from review outcome', () => {
  const result = denialResult({ id: 'request-1', providerCallId: 'call-1', toolName: 'fs.write_text' }, {
    outcome: 'deny_with_guidance', reasonCode: 'intent_mismatch', guidance: 'Use a permitted target.',
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.review_outcome, 'deny_with_guidance');
  const record = toolResultRecord({ result }, 'turn-1', 'step-1');
  assert.equal(record.toolLifecycleStatus, 'denied');
  assert.equal(record.reviewOutcome, 'deny_with_guidance');
  assert.equal('status' in record, false);
});

test('ordinary tool results have one lifecycle field and no review outcome', () => {
  const record = toolResultRecord({ result: {
    request_id: 'request-1', provider_call_id: 'call-1', tool_name: 'fs.read',
    status: 'succeeded', content: 'ok', effect_certainty: 'completed',
  } }, 'turn-1');
  assert.equal(record.toolLifecycleStatus, 'succeeded');
  assert.equal('reviewOutcome' in record, false);
  assert.equal(toolReviewOutcome(record), null);
});

test('provider projection names lifecycle and review fields explicitly', () => {
  const transcript = [
    { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.write_text', args: { path: 'a.txt' } },
    {
      type: 'tool_result', providerCallId: 'call-1', toolName: 'fs.write_text',
      toolLifecycleStatus: 'denied', reviewOutcome: 'hard_deny', content: 'policy boundary',
    },
  ];
  const context = buildContext({
    workspaceRoot: process.cwd(), limits: { maxContextBytes: 1_048_576 }, executionManifest: null,
  }, transcript, 'Continue.');
  const projected = JSON.parse(context.find((item) => item.role === 'tool').content);
  assert.equal(projected.tool_lifecycle_status, 'denied');
  assert.equal(projected.status, 'denied');
  assert.equal(projected.review_outcome, 'hard_deny');
});

test('result cache restores legacy journal status through the compatibility reader', () => {
  const cache = new ToolResultCache();
  const call = { providerCallId: 'call-1', name: 'fs.write_text', args: { path: 'a.txt' } };
  cache.restore([
    { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.write_text', args: { path: 'a.txt' } },
    {
      type: 'tool_result', requestId: 'request-1', providerCallId: 'call-1',
      toolName: 'fs.write_text', status: 'deny_with_guidance', content: 'legacy denial',
    },
  ]);
  const restored = cache.lookup(call);
  assert.equal(restored.status, 'denied');
  assert.equal(restored.review_outcome, 'deny_with_guidance');
});
