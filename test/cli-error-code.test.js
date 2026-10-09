// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { cliErrorCode } from '../src/cli-error-code.js';

test('CLI keeps a shared nested code without exposing aggregate details', () => {
  const failure = new AggregateError([
    { code: 'nnd_activation_health_invalid', message: 'private detail' },
    new AggregateError([{ code: 'nnd_activation_health_invalid' }], 'nested detail'),
  ], 'aggregate detail');
  assert.equal(cliErrorCode(failure), 'nnd_activation_health_invalid');
  assert.equal(cliErrorCode(new AggregateError([{ code: 'one' }, { code: 'two' }])), 'internal_failure');
  assert.equal(cliErrorCode({ code: 'secret\nvalue' }), 'internal_failure');
});
