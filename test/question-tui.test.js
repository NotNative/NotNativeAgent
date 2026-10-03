// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine } from '../src/experience-engine.js';
import { TuiProjection } from '../src/experience/projection.js';
import { TerminalInputDecoder } from '../src/tui/terminal-adapter.js';
import { TuiRenderer } from '../src/tui/renderer.js';
import { handleActions } from '../src/tui.js';

function config(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  });
}

function providerFor(questions, toolMessages) {
  let step = 0;
  return { async *stream(request) {
    step += 1;
    if (step === 1) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'question-call', function: {
        name: 'question', arguments: JSON.stringify({ questions }),
      } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    toolMessages.push(request.messages.filter((item) => item.role === 'tool').at(-1));
    yield { type: 'text', text: 'Done.' };
    yield { type: 'terminal' };
  } };
}

async function start(questions) {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-tui-'));
  const projection = new TuiProjection();
  const toolMessages = [];
  const provider = providerFor(questions, toolMessages);
  const workspace = new ExperienceEngine({
    config: config(root), projection, storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewers'), providerFactory: () => provider,
  });
  await workspace.create('Main');
  projection.active().editor.insert('unsent draft');
  const turn = workspace.submitActive('Ask me.');
  for (let i = 0; i < 400 && !projection.active().pendingQuestion; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(projection.active().pendingQuestion, 'question must reach Console projection');
  const act = async (...actions) => handleActions(actions.map((action) => typeof action === 'string' ? { action } : action),
    workspace, () => undefined, new TerminalInputDecoder());
  return { workspace, projection, toolMessages, turn, act };
}

test('Console displays and answers a mid-turn question without consuming the draft', async () => {
  const setup = await start([{ question: 'Which release?', header: 'Release',
    options: [{ label: 'stable', description: 'Ship now' }, { label: 'beta' }] }]);
  try {
    const frame = new TuiRenderer().frame(setup.projection, { width: 90, height: 24, color: false });
    assert.match(frame, /QUESTION FOR YOU/u);
    assert.match(frame, /Which release\?/u);
    assert.match(frame, /stable/u);
    await setup.act('history_down', 'submit');
    assert.equal((await setup.turn).outcome, 'completed');
    assert.match(setup.toolMessages[0].content, /\[\["beta"\]\]/u);
    assert.equal(setup.projection.active().pendingQuestion, null);
    assert.equal(setup.projection.active().editor.text, 'unsent draft');
  } finally { await setup.workspace.shutdown(); }
});

test('Console supports batched multiple and custom answers', async () => {
  const setup = await start([
    { question: 'Choose flags', options: [{ label: 'one' }, { label: 'two' }], multiple: true },
    { question: 'Name target', options: [{ label: 'default' }], custom: true },
  ]);
  try {
    await setup.act('submit', 'history_down', 'submit', 'history_down', 'submit');
    assert.equal(setup.projection.active().pendingQuestion.index, 1);
    setup.workspace.options.clipboardRead = async () => 'custom-target';
    await setup.act('history_down', 'submit', 'paste_clipboard', 'submit');
    assert.equal((await setup.turn).outcome, 'completed');
    assert.match(setup.toolMessages[0].content, /\[\["one","two"\],\["custom-target"\]\]/u);
  } finally { await setup.workspace.shutdown(); }
});

test('Console declines a question without cancelling its turn', async () => {
  const setup = await start([{ question: 'Proceed?', options: [{ label: 'yes' }] }]);
  try {
    await setup.act('back');
    assert.notEqual(setup.projection.active().state, 'cancelling');
    await setup.turn;
    assert.equal(setup.projection.active().pendingQuestion, null);
    assert.equal(setup.projection.active().editor.text, 'unsent draft');
  } finally { await setup.workspace.shutdown(); }
});

test('Console keeps the selected option visible in a small terminal and accepts a click', async () => {
  const setup = await start([{ question: 'Pick an option', options: [
    { label: 'first', description: 'x'.repeat(500) },
    { label: 'second', description: 'y'.repeat(500) },
    { label: 'third' },
  ] }]);
  try {
    await setup.act('history_down', 'history_down');
    const renderer = new TuiRenderer();
    const frame = renderer.frame(setup.projection, { width: 30, height: 10, color: false });
    assert.match(frame, /› 3\. third/u);
    await setup.act('scroll_page_up');
    assert.match(renderer.frame(setup.projection, { width: 30, height: 10, color: false }), /Pick an option/u);
    await setup.act('history_up', 'history_down');
    renderer.frame(setup.projection, { width: 30, height: 10, color: false });
    const target = setup.projection.mouseTargets.find((item) => item.type === 'question-option' && item.index === 2);
    assert.ok(target);
    await setup.act({ action: 'mouse', pressed: true, button: 0, row: target.row });
    assert.equal((await setup.turn).outcome, 'completed');
    assert.match(setup.toolMessages[0].content, /\[\["third"\]\]/u);
  } finally { await setup.workspace.shutdown(); }
});

test('question prompts identify inactive tabs and clear on turn cancellation', () => {
  const projection = new TuiProjection();
  projection.addSession('first', 'First', {});
  projection.addSession('second', 'Second', {});
  projection.apply('second', { type: 'question_prompt', question_token: 'que_test',
    questions: [{ header: 'Choose', question: 'Choose?', options: [{ label: 'yes', description: '' }],
      multiple: false, custom: false }] });
  assert.equal(projection.sessions.get('second').unread, true);
  assert.equal(projection.sessions.get('second').pendingQuestion.token, 'que_test');
  projection.activate('second');
  const frame = new TuiRenderer().frame(projection, { width: 60, height: 16, color: false });
  assert.match(frame, /QUESTION FOR YOU/u);
  projection.apply('second', { type: 'turn_result', outcome: 'cancelled' });
  assert.equal(projection.sessions.get('second').pendingQuestion, null);
});

test('Console advances queued concurrent questions after each canonical answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-question-queue-'));
  const projection = new TuiProjection();
  projection.addSession('session_a', 'Main', {});
  const submitted = [];
  const workspace = new ExperienceEngine({ config: config(root), projection });
  workspace.sessions.set('session_a', { id: 'session_a', ingress: { async submit(command) {
    submitted.push(command);
    return { accepted: true };
  } } });
  for (const token of ['que_first', 'que_second']) projection.apply('session_a', {
    type: 'question_prompt', question_token: token,
    questions: [{ header: 'Choose', question: 'Choose?', options: [{ label: 'yes', description: '' }],
      multiple: false, custom: false }],
  });
  assert.equal(projection.active().pendingQuestion.token, 'que_first');
  assert.equal(projection.active().questionQueue.length, 1);
  await workspace.answerActiveQuestion([['yes']]);
  assert.equal(projection.active().pendingQuestion.token, 'que_second');
  await workspace.answerActiveQuestion([['yes']]);
  assert.equal(projection.active().pendingQuestion, null);
  assert.deepEqual(submitted.map((item) => item.question_token), ['que_first', 'que_second']);
});
