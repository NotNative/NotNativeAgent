// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestionBroker } from '../src/question-broker.js';
import { validateCommand } from '../src/contracts.js';

function batch(overrides = {}) {
  return {
    questions: [{
      question: 'Which deployment target?', header: 'Target',
      options: [{ label: 'left', description: 'blue' }, { label: 'right' }],
      ...overrides,
    }],
  };
}

async function askBroker(options = {}) {
  const emitted = { asked: [], settled: [], records: [] };
  const broker = new QuestionBroker({
    ...options,
    output: async (record) => { emitted.records.push(record); },
    emit: {
      asked: (pending) => emitted.asked.push(pending.token),
      settled: (pending, kind) => emitted.settled.push({ token: pending.token, kind }),
    },
  });
  return { broker, emitted };
}

test('an answered question settles the pending tool call with the operator matrix', async () => {
  const { broker, emitted } = await askBroker();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  const pending = broker.snapshot()[0];
  assert.equal(broker.snapshot().length, 1);
  assert.equal(emitted.records[0].type, 'question_prompt');
  assert.equal(emitted.records[0].question_token, pending.token);
  assert.equal(emitted.asked[0], pending.token);
  const result = broker.answer({ question_token: pending.token, answers: [['left']] }, 'operator-principal');
  assert.equal(result.accepted, true);
  const settled = await wait;
  assert.equal(settled.status, 'succeeded');
  assert.equal(settled.reasonCode, 'operator_answered');
  assert.deepEqual(JSON.parse(settled.payload), [['left']]);
  assert.deepEqual(settled.metadata.answers, [['left']]);
  assert.equal(broker.snapshot().length, 0);
  assert.deepEqual(emitted.settled, [{ token: pending.token, kind: 'replied' }]);
});

test('a declined question settles denied with an honest operator speech-act', async () => {
  const { broker, emitted } = await askBroker();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  const pending = broker.snapshot()[0];
  broker.decline({ question_token: pending.token, reason: 'dismissed' }, 'operator-principal');
  const settled = await wait;
  assert.equal(settled.status, 'denied');
  assert.equal(settled.reasonCode, 'operator_declined');
  assert.equal(settled.payload, 'The user dismissed this question');
  assert.equal(settled.metadata.effect_certainty, 'none');
  assert.deepEqual(emitted.settled, [{ token: pending.token, kind: 'rejected' }]);
});

test('turn abort settles a pending question without an operator decision', async () => {
  const { broker, emitted } = await askBroker();
  const controller = new AbortController();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, controller.signal);
  const pending = broker.snapshot()[0];
  controller.abort();
  const settled = await wait;
  assert.equal(settled.status, 'denied');
  assert.equal(settled.reasonCode, 'operator_cancelled');
  assert.equal(settled.principal, 'engine');
  assert.deepEqual(emitted.settled, [{ token: pending.token, kind: 'rejected' }]);
  assert.equal(broker.snapshot().length, 0);
});

test('a question never times out into denial without timeout support', async () => {
  const { broker } = await askBroker();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(broker.snapshot().length, 1);
  const pending = broker.snapshot()[0];
  broker.answer({ question_token: pending.token, answers: [['right']] }, 'operator-principal');
  const settled = await wait;
  assert.equal(settled.status, 'succeeded');
});

test('re-asked requests reuse the pending wait instead of double-prompting', async () => {
  const { broker, emitted } = await askBroker();
  const signal = new AbortController().signal;
  const first = broker.ask({ id: 'tool-1', args: batch() }, signal);
  const second = broker.ask({ id: 'tool-1', args: batch() }, signal);
  assert.equal(broker.snapshot().length, 1);
  assert.equal(emitted.asked.length, 1);
  assert.equal(emitted.records.length, 1);
  const pending = broker.snapshot()[0];
  broker.answer({ question_token: pending.token, answers: [['left']] }, 'operator');
  assert.equal(await first, await second);
});

test('the pending queue is bounded', async () => {
  const { broker } = await askBroker({ maxPending: 1 });
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  await assert.rejects(
    broker.ask({ id: 'tool-2', args: batch() }, new AbortController().signal),
    { code: 'question_request_invalid' },
  );
  const pending = broker.snapshot()[0];
  broker.answer({ question_token: pending.token, answers: [['left']] }, 'operator');
  await wait;
});

test('batch bounds reject malformed questions at the broker boundary', async () => {
  const { broker } = await askBroker();
  await assert.rejects(broker.ask({ id: 't', args: { questions: [] } }, new AbortController().signal),
    { code: 'question_batch_invalid' });
  await assert.rejects(broker.ask({ id: 't', args: { questions: Array.from({ length: 9 }, (_, i) => ({
    question: `q${i}`, options: [{ label: 'x' }],
  })) } }, new AbortController().signal), { code: 'question_batch_invalid' });
  await assert.rejects(broker.ask({ id: 't', args: batch({
    options: Array.from({ length: 17 }, (_, i) => ({ label: `o${i}` })),
  }) }, new AbortController().signal), { code: 'question_batch_invalid' });
  await assert.rejects(broker.ask({ id: 't', args: batch({ options: [{ label: ' ' }] }) },
    new AbortController().signal), { code: 'question_batch_invalid' });
});

test('settlement of unknown or stale tokens is rejected', async () => {
  const { broker } = await askBroker();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  const pending = broker.snapshot()[0];
  assert.throws(() => broker.answer({ question_token: 'que_missing', answers: [['left']] }, 'op'),
    { code: 'question_unknown' });
  broker.answer({ question_token: pending.token, answers: [['left']] }, 'op');
  await wait;
  assert.throws(() => broker.answer({ question_token: pending.token, answers: [['left']] }, 'op'),
    { code: 'question_unknown' });
});

test('answer matrices are bounded and labelled', async () => {
  const { broker } = await askBroker();
  const wait = broker.ask({ id: 'tool-1', args: batch() }, new AbortController().signal);
  const pending = broker.snapshot()[0];
  assert.throws(() => broker.answer({ question_token: pending.token, answers: [] }, 'op'),
    { code: 'question_request_invalid' });
  assert.throws(() => broker.answer({ question_token: pending.token, answers: [[' ']] }, 'op'),
    { code: 'question_request_invalid' });
  assert.throws(() => broker.answer({ question_token: pending.token, answers: [Array.from({ length: 9 }, (_, i) => `l${i}`)] }, 'op'),
    { code: 'question_request_invalid' });
  broker.answer({ question_token: pending.token, answers: [['left', 'right']] }, 'op');
  const settled = await wait;
  assert.equal(settled.status, 'succeeded');
});

test('question commands are interactive-only protocol surface', () => {
  const base = { version: '1.0', request_id: 'reply-1', question_token: 'que_abc' };
  assert.equal(validateCommand({ ...base, type: 'question_response', answers: [['left']] },
    { interactive: true }).type, 'question_response');
  assert.equal(validateCommand({ ...base, type: 'question_decline', reason: 'dismissed' },
    { interactive: true }).type, 'question_decline');
  assert.throws(() => validateCommand({ ...base, type: 'question_response', answers: [['left']] }),
    { code: 'unknown_control' });
  assert.throws(() => validateCommand({ ...base, type: 'question_decline', reason: 'spite' },
    { interactive: true }), { code: 'question_request_invalid' });
  assert.throws(() => validateCommand({ ...base, type: 'question_response', answers: 'left' },
    { interactive: true }), { code: 'question_request_invalid' });
  assert.throws(() => validateCommand({ ...base, type: 'question_response', answers: Array.from({ length: 9 }, (_, i) => [`a${i}`]) },
    { interactive: true }), { code: 'question_request_invalid' });
});
