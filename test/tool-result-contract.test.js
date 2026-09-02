// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durableToolResultState, toolChildState, toolLifecycleStatus, toolReviewOutcome, toolTelemetryOutcome,
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

test('all lifecycle statuses use one exhaustive child and telemetry projection table', () => {
  const expected = {
    succeeded: ['succeeded', 'succeeded'],
    failed: ['failed', 'failed'],
    completed_nonzero: ['failed', 'failed'],
    cancelled: ['cancelled', 'cancelled'],
    timed_out: ['timed_out', 'timed_out'],
    invalid_request: ['failed', 'failed'],
    denied: ['failed', 'denied'],
    unknown_effect: ['unknown_effect', 'unknown_effect'],
  };
  for (const [status, [child, telemetry]] of Object.entries(expected)) {
    assert.equal(toolChildState({ status }), child, status);
    assert.equal(toolTelemetryOutcome({ status }), telemetry, status);
  }
  assert.equal(toolChildState({ status: 'failed', effect_certainty: 'unknown' }), 'unknown_effect');
  assert.equal(toolTelemetryOutcome({ status: 'failed', effect_certainty: 'unknown' }), 'unknown_effect');
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
  assert.equal(projected.envelope_version, 'nna.tool-result.v2');
  assert.equal(projected.status, 'denied');
  assert.equal(projected.review_outcome, 'hard_deny');
  assert.equal(projected.content_projection, 'full');
  assert.deepEqual(projected.projection_metadata, {
    mode: 'full', original_bytes: 15, projected_bytes: 15, omitted_bytes: 0, reason: null,
  });
  assert.equal(projected.untrusted, true);
});

test('provider projection distinguishes full, redacted, bounded, and receipt content', () => {
  const project = (metadata) => {
    const transcript = [
      { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.read', args: { path: 'a.txt' } },
      {
        type: 'tool_result', providerCallId: 'call-1', toolName: 'fs.read',
        toolLifecycleStatus: 'succeeded', content: 'evidence', metadata,
      },
    ];
    const context = buildContext({
      workspaceRoot: process.cwd(), limits: { maxContextBytes: 1_048_576 }, executionManifest: null,
    }, transcript, 'Continue.');
    return JSON.parse(context.find((item) => item.role === 'tool').content);
  };

  assert.equal(project(null).content_projection, 'full');
  const redacted = project({ contentRedacted: true, originalBytes: 42, projectionReason: 'secret_redaction' });
  assert.equal(redacted.content_projection, 'redacted');
  assert.deepEqual(redacted.projection_metadata, {
    mode: 'redacted', original_bytes: 42, projected_bytes: 8, omitted_bytes: 34, reason: 'secret_redaction',
  });
  assert.equal(project({ compacted: true, reason: 'active_pressure_receipt' }).content_projection, 'bounded');
  assert.equal(project({
    compacted: true, reason: 'semantic_tool_receipt', receiptSchema: 'nna.tool-receipt.v1',
  }).content_projection, 'receipt');
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
