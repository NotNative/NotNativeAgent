// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { deduplicateToolCallBatch } from '../src/reliability/tool-call-deduplication.js';

test('exact same-batch tool calls collapse before governance while distinct calls retain order', () => {
  const first = call('call-1', 'fs.read', { path: 'README.md', options: { end: 2, start: 1 } });
  const duplicate = call('call-2', 'fs.read', { options: { start: 1, end: 2 }, path: 'README.md' });
  const distinct = call('call-3', 'fs.read', { path: 'package.json' });
  const result = deduplicateToolCallBatch([first, duplicate, distinct]);

  assert.deepEqual(result.calls, [first, distinct]);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].providerCallId, 'call-2');
  assert.equal(result.suppressed[0].retainedProviderCallId, 'call-1');
  assert.equal(result.suppressed[0].toolName, 'fs.read');
  assert.match(result.suppressed[0].identityFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result.suppressed).includes('README.md'), false);
});

test('malformed calls remain visible to ordinary validation and recovery', () => {
  const invalidA = Object.freeze({ providerCallId: 'bad-1', name: 'fs.read', args: {}, invalid: { code: 'malformed' } });
  const invalidB = Object.freeze({ providerCallId: 'bad-2', name: 'fs.read', args: {}, invalid: { code: 'malformed' } });
  const result = deduplicateToolCallBatch([invalidA, invalidB]);
  assert.deepEqual(result.calls, [invalidA, invalidB]);
  assert.deepEqual(result.suppressed, []);
});

function call(providerCallId, name, args) {
  return Object.freeze({ providerCallId, name, args: Object.freeze(args) });
}
