// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { reachedOutputCeiling } from '../src/reliability/output-headroom.js';

test('one output-ceiling predicate recognizes provider finish reasons and usage aliases', () => {
  for (const finishReason of ['length', 'MAX_TOKENS', 'max_output_tokens']) {
    assert.equal(reachedOutputCeiling({ finishReason }), true);
  }
  for (const key of ['completion_tokens', 'output_tokens', 'outputTokens']) {
    assert.equal(reachedOutputCeiling({ outputLimitTokens: 32, usage: { [key]: 32 } }), true);
  }
});

test('output-ceiling inference fails closed for incomplete or below-limit evidence', () => {
  assert.equal(reachedOutputCeiling(), false);
  assert.equal(reachedOutputCeiling({ outputLimitTokens: 32, usage: [] }), false);
  assert.equal(reachedOutputCeiling({ outputLimitTokens: 32, usage: { output_tokens: 31 } }), false);
  assert.equal(reachedOutputCeiling({ outputLimitTokens: 0, usage: { output_tokens: 32 } }), false);
});
