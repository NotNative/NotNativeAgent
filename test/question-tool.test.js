// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestionBroker } from '../src/question-broker.js';
import { questionDefinition } from '../src/tools/question.js';

const BATCH = { questions: [{ question: 'Which release channel?', options: [{ label: 'stable' }, { label: 'beta' }] }] };

test('the question tool exists only behind an installed broker and waits without a timeout', () => {
  assert.equal(questionDefinition(null), null);
  assert.equal(questionDefinition({ ask: 'not-a-function' }), null);
  const definition = questionDefinition(new QuestionBroker());
  assert.equal(definition.name, 'question');
  assert.equal(definition.sideEffect, 'read_only');
  assert.equal(definition.scope, 'conversation_control');
  assert.equal(definition.cancellation, true);
  assert.equal(definition.timeoutMs, null);
});

test('the question tool seals its batch through the shared batch validator', async () => {
  const definition = questionDefinition(new QuestionBroker());
  const sealed = await definition.validate(BATCH);
  assert.equal(sealed.resolved.scope, 'active_turn');
  assert.equal(sealed.args.questions[0].header, 'Which release channel?');
  assert.equal(sealed.args.questions[0].options[1].label, 'beta');
  await assert.rejects(definition.validate({ questions: [] }), { code: 'question_batch_invalid' });
  await assert.rejects(definition.validate({ questions: [{ question: 'q', options: [{ label: ' ' }] }] }),
    { code: 'question_batch_invalid' });
});

test('the question executor returns settled operator speech as ordinary tool content', async () => {
  const records = [];
  const broker = new QuestionBroker({ output: async (record) => { records.push(record); } });
  const definition = questionDefinition(broker);
  const sealed = await definition.validate(BATCH);
  const request = { id: 'tool-question-1', providerCallId: 'call-1', args: sealed.args };
  const signal = new AbortController().signal;
  const running = definition.executor(request, signal);
  const pending = broker.snapshot()[0];
  assert.equal(records[0].question_token, pending.token);
  broker.answer({ question_token: pending.token, answers: [['stable']] }, 'operator');
  const result = await running;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.content), [['stable']]);
  assert.equal(result.reasonCode, 'operator_answered');
});

test('the question executor surfaces a decline as a denied result without inventing content', async () => {
  const broker = new QuestionBroker({ output: async () => undefined });
  const definition = questionDefinition(broker);
  const sealed = await definition.validate(BATCH);
  const running = definition.executor({ id: 'tool-question-2', providerCallId: 'call-2', args: sealed.args },
    new AbortController().signal);
  broker.decline({ question_token: broker.snapshot()[0].token, reason: 'dismissed' }, 'operator');
  const result = await running;
  assert.equal(result.status, 'denied');
  assert.equal(result.reasonCode, 'operator_declined');
  assert.match(result.content, /dismissed/u);
});
