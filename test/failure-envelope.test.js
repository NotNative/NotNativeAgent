// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { failureEnvelope } from '../src/failure-envelope.js';
import { ContractError } from '../src/ids.js';

function classified(code, operation = 'turn') {
  return failureEnvelope(new ContractError(code, 'bounded failure'), { operation });
}

test('failure taxonomy gives qualified provider codes provider ownership', () => {
  assert.deepEqual(
    ['provider_event_invalid', 'provider_usage_invalid'].map((code) => {
      const failure = classified(code);
      return [failure.category, failure.boundary];
    }),
    [['provider', 'provider'], ['provider', 'provider']],
  );
});

test('streamed tool identity drift belongs to the provider boundary', () => {
  const failure = classified('tool_identity_drift');
  assert.equal(failure.category, 'provider');
  assert.equal(failure.boundary, 'provider');
});

test('failure taxonomy separates lifecycle category from component boundary', () => {
  const provider = classified('provider_timeout');
  assert.equal(provider.category, 'timeout');
  assert.equal(provider.boundary, 'provider');
  const tool = classified('tool_cancelled');
  assert.equal(tool.category, 'cancelled');
  assert.equal(tool.boundary, 'tool');
});

test('failure taxonomy classifies named domains without substring collisions', () => {
  assert.equal(classified('tool_schema_invalid').category, 'tool');
  assert.equal(classified('reviewer_output_malformed').category, 'authorization');
  assert.equal(classified('journal_corrupt').category, 'persistence');
  assert.equal(classified('invalid_manifest').category, 'contract');
  assert.equal(classified('unrelated_providerish_invalidity').category, 'internal');
});
