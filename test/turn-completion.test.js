// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { turnFinishDefinition } from '../src/tools/turn-completion.js';

function definition() {
  return turnFinishDefinition({ declare(value) { return value; } });
}

test('turn.finish states the conditional reason and question contract on the provider surface', () => {
  const tool = definition();
  assert.match(tool.purpose, /Omit reason_code and question/u);
  assert.match(tool.inputSchema.properties.reason_code.description, /Forbidden for completed and needs_input/u);
  assert.match(tool.inputSchema.properties.question.description, /Forbidden for every other outcome/u);
});

test('turn.finish accepts only the fields required by each outcome', async () => {
  assert.deepEqual((await definition().validate({ outcome: 'completed' })).args, {
    outcome: 'completed', reason_code: null, question: null,
  });
  assert.deepEqual((await definition().validate({ outcome: 'failed', reason_code: 'objective_failed' })).args, {
    outcome: 'failed', reason_code: 'objective_failed', question: null,
  });
  assert.deepEqual((await definition().validate({ outcome: 'needs_input', question: 'Which target?' })).args, {
    outcome: 'needs_input', reason_code: null, question: 'Which target?',
  });
});

test('turn.finish rejection explains how to repair conditionally forbidden fields', async () => {
  await assert.rejects(definition().validate({ outcome: 'completed', reason_code: 'done' }), {
    code: 'tool_schema_invalid',
    message: 'reason_code is accepted only when outcome is blocked, incomplete, or failed; omit reason_code for completed and needs_input',
  });
  await assert.rejects(definition().validate({ outcome: 'failed' }), {
    code: 'tool_schema_invalid', message: 'turn.finish requires a valid reason_code when outcome is failed',
  });
  await assert.rejects(definition().validate({ outcome: 'completed', question: 'Done?' }), {
    code: 'tool_schema_invalid',
    message: 'question is accepted only when outcome is needs_input; omit question for every other outcome',
  });
});
