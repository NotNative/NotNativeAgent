// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';

function manifest(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  });
}

function questionFragments() {
  const args = { questions: [{ question: 'Which channel?', options: [{ label: 'stable' }, { label: 'beta' }] }] };
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id: 'question-call', function: { name: 'question', arguments: JSON.stringify(args) } }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

function once(provider) { return () => provider; }

function askingProvider(capture) {
  let step = 0;
  return { async *stream(request) {
    step += 1;
    if (step === 1) { yield* questionFragments(); return; }
    if (capture) capture.push(request.messages.filter((item) => item.role === 'tool').at(-1));
    yield { type: 'text', text: 'shipping stable' };
    yield { type: 'terminal' };
  } };
}

test('interactive surfaces offer the question tool and headless surfaces do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-surface-'));
  const interactive = new SessionEngine({
    config: manifest(root), surface: 'interactive_tui',
    providerFactory: once(askingProvider()), output: async () => undefined,
  });
  await interactive.initialize();
  const names = interactive.tools.providerDefinitions('release').map((item) => item.function.name);
  assert.ok(names.includes('question'));

  const headless = new SessionEngine({
    config: manifest(root), providerFactory: once(askingProvider()), output: async () => undefined,
  });
  await headless.initialize();
  const headlessNames = headless.tools.providerDefinitions('release').map((item) => item.function.name);
  assert.ok(!headlessNames.includes('question'));
  assert.throws(() => headless.decideQuestion({ request_id: 'q', question_token: 'que_x', answers: [['a']] }, 'op'),
    { code: 'interactive_decision_forbidden' });
});

test('a mid-turn question pauses the tool call, resumes on the real answer, and continues the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-answer-'));
  const toolMessages = [];
  const outputs = [];
  let engine;
  const output = async (event) => {
    outputs.push(event);
    if (event.type === 'question_prompt') {
      engine.decideQuestion({
        request_id: 'question-reply', question_token: event.question_token, answers: [['stable']],
      }, 'authenticated-interactive-operator');
    }
  };
  engine = new SessionEngine({
    config: manifest(root), surface: 'interactive_tui',
    providerFactory: once(askingProvider(toolMessages)), output,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'question-turn', content: 'Ship the release.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(outputs.filter((item) => item.type === 'question_prompt').length, 1);
  const prompt = outputs.find((item) => item.type === 'question_prompt');
  assert.equal(prompt.narrative, 'Which channel?');
  assert.equal(prompt.questions[0].options.length, 2);
  assert.equal(toolMessages.length, 1);
  assert.match(toolMessages[0].content, /\[\["stable"\]\]/u);
  assert.match(toolMessages[0].content, /"untrusted":true/u);
  assert.equal(engine.questionBroker.snapshot().length, 0);
});

test('prompt posture reviews ordinary writes but never gates the question tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-posture-'));
  const outputs = [];
  let engine;
  const output = async (event) => {
    outputs.push(event);
    if (event.type === 'question_prompt') {
      engine.declineQuestion({
        request_id: 'question-decline', question_token: event.question_token, reason: 'dismissed',
      }, 'authenticated-interactive-operator');
    }
  };
  engine = new SessionEngine({
    config: manifest(root), surface: 'interactive_tui', reviewPosture: 'prompt',
    providerFactory: once(askingProvider()), output,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'declined-question-turn', content: 'Ship the release.' }, 'operator');
  assert.equal(outputs.some((item) => item.type === 'permission_prompt' && item.tool === 'question'), false);
  const questionStatuses = outputs.filter((item) => item.type === 'tool_status' && item.tool === 'question')
    .map((item) => item.status);
  assert.deepEqual(questionStatuses, ['review_pending', 'approved', 'running', 'denied']);
  assert.equal(result.outcome, 'blocked');
});

test('cancelling a turn releases the pending question without an operator answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-cancel-'));
  let promptSeen = null;
  let engine;
  const output = async (event) => {
    if (event.type === 'question_prompt') promptSeen = event;
  };
  engine = new SessionEngine({
    config: manifest(root), surface: 'interactive_tui',
    providerFactory: once(askingProvider()), output,
  });
  await engine.initialize();
  const turn = engine.submit({ request_id: 'cancel-question-turn', content: 'Ship the release.' }, 'operator');
  while (promptSeen === null) await new Promise((resolve) => { setTimeout(resolve, 1); });
  await engine.cancel({ request_id: 'cancel-question-command' });
  const result = await turn;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(engine.questionBroker.snapshot().length, 0);
});
