// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { reviewProviderDelta, REVIEW_ALLOWED_CONTENT, REVIEW_ALLOWED_FILE, REVIEW_DENIED_FILE } from './installed-attachment-probe.mjs';

function review(mode, path) {
  return { messages: [{ content: 'You are an isolated tool-permission decision component.' },
    { role: 'user', content: JSON.stringify({
      authenticatedIntent: [{ content: `NND_ALPHA_REVIEW_${mode.toUpperCase()}`, sequence: 3 }],
      request: { toolName: 'fs_write_text', args: { path,
        content_sha256: createHash('sha256').update(REVIEW_ALLOWED_CONTENT).digest('hex'),
        content_bytes: Buffer.byteLength(REVIEW_ALLOWED_CONTENT) } },
    }) }] };
}

test('installed reviewer fixture approves only the exact authenticated write', () => {
  const reviews = [];
  const allowed = reviewProviderDelta(review('allow', REVIEW_ALLOWED_FILE), reviews);
  const denied = reviewProviderDelta(review('deny', REVIEW_DENIED_FILE), reviews);
  const mismatched = reviewProviderDelta(review('allow', REVIEW_DENIED_FILE), reviews);
  assert.equal(JSON.parse(allowed.delta.content).outcome, 'approve');
  assert.equal(JSON.parse(denied.delta.content).outcome, 'deny_with_guidance');
  assert.equal(JSON.parse(mismatched.delta.content).outcome, 'deny_with_guidance');
  assert.deepEqual(reviews.map(item => item.approved), [true, false, false]);
});

test('installed provider searches before requesting a reviewed write', () => {
  const reviews = [];
  const prompt = { role: 'user', content: 'NND_ALPHA_REVIEW_ALLOW' };
  const first = reviewProviderDelta({ messages: [prompt] }, reviews);
  assert.equal(first.delta.tool_calls[0].function.name, 'tool_search');
  const second = reviewProviderDelta({ messages: [prompt,
    { role: 'tool', tool_call_id: 'nnd_alpha_review_search_allow', content: '{}' }] }, reviews);
  assert.equal(second.delta.tool_calls[0].function.name, 'fs_write_text');
  assert.equal(JSON.parse(second.delta.tool_calls[0].function.arguments).path, REVIEW_ALLOWED_FILE);
});
