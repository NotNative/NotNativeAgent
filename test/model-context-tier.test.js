// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextTierLabel } from '../src/tui/model-overlay.js';

test('a measured limit is named as a measurement', () => {
  assert.equal(contextTierLabel({ context_limit_tokens: 131_072, context_limit_bytes: 300_000 }), '131,072 ctx');
});

test('an operator limit is named as configured, never as measured', () => {
  assert.equal(contextTierLabel({ context_limit_tokens: null, context_limit_bytes: 400_000 }), '100,000 ctx (configured)');
});

test('a limit nobody proved stays unknown instead of becoming zero or a guess', () => {
  assert.equal(contextTierLabel({ context_limit_tokens: null, context_limit_bytes: null }), 'ctx unknown');
  assert.equal(contextTierLabel({}), 'ctx unknown');
  assert.equal(contextTierLabel(null), 'ctx unknown');
});
