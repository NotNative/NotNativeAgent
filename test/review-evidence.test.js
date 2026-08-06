// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentReviewEvidence } from '../src/review-evidence.js';

test('review evidence exposes bounded redacted causal results without granting authority', () => {
  const evidence = recentReviewEvidence([
    { type: 'message', role: 'user', content: 'Find fixture-host' },
    { type: 'message', role: 'assistant', content: 'Resolving the host.' },
    { type: 'tool_result', requestId: 'old', toolName: 'process.run', status: 'succeeded', content: 'fixture-host = 192.0.2.15 token=hidden-value' },
    { type: 'tool_request', requestId: 'current', toolName: 'process.run' },
  ], 'current');
  assert.deepEqual(evidence.map((item) => item.trust), ['untrusted_model', 'untrusted_tool']);
  assert.match(evidence[1].content, /192\.168\.20\.15/u);
  assert.doesNotMatch(evidence[1].content, /hidden-value/u);
  assert.equal(Object.isFrozen(evidence), true);
});

test('review evidence is record- and byte-bounded', () => {
  const transcript = Array.from({ length: 20 }, (_, index) => ({
    type: 'tool_result', requestId: `old-${index}`, toolName: 'process.run',
    status: 'succeeded', content: `${index}:${'x'.repeat(4_000)}`,
  }));
  const evidence = recentReviewEvidence(transcript, 'current');
  assert.equal(evidence.length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 9_000);
});
