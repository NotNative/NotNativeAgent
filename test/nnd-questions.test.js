// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { TypedSessionEngine } from './typed-provider-fixture.js';
import { resolveManifest } from '../src/config.js';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { dispatchNndQuestionRequest } from '../src/nnd-question-routes.js';
import { sendFailure } from '../src/secret-broker-server.js';
import { QuestionBroker } from '../src/question-broker.js';
import { CanonicalIngress } from '../src/ingress.js';
import { listNndQuestions, settleNndQuestion } from '../src/nnd-questions.js';

const owner = { subjectId: 'owner', workspaceIds: ['workspace_a', 'workspace_b'], permissions: ['nnd.read', 'nnd.session.submit'] };
const args = { questions: [{ question: 'Choose a channel', custom: false, options: [{ label: 'stable' }, { label: 'beta' }] }] };
const callTool = (id, name, input) => [{ type: 'tool_fragment', fragments: [{ index: 0, id, function: { name, arguments: JSON.stringify(input) } }] }, { type: 'terminal', finishReason: 'tool_calls' }];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-question-')); const events = []; const results = [];
  const provider = { async *stream(request) {
    if (!request.messages.some((item) => item.role === 'tool' && item.tool_call_id === 'search_a')) { yield* callTool('search_a', 'tool_search', { query: 'question' }); return; }
    if (!request.messages.some((item) => item.role === 'tool' && item.tool_call_id === 'question_a')) { yield* callTool('question_a', 'question', args); return; }
    results.push(request.messages.filter((item) => item.role === 'tool').at(-1));
    yield { type: 'text', text: 'Question journey completed' }; yield { type: 'terminal' };
  } };
  const config = resolveManifest({ persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } });
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (input) => new TypedSessionEngine({ config, surface: 'nnd', sessionId: input.sessionId,
      output: input.output, providerFactory: () => provider, hookRoots: [], skillRoots: [] }) });
  const context = await host.create('session_a', owner);
  t.after(async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }); });
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'Ask me which channel to use.' }, owner);
  await until(() => host.questions(owner).length === 1);
  const question = host.questions(owner)[0];
  return { host, context, events, results, question };
}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('question journey timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function call(host, path, actor = owner, body, method = body === undefined ? 'GET' : 'POST') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); request.method = method;
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
  try { await dispatchNndQuestionRequest(request, response, { url: new URL(path, 'http://nna'), nndEngineHost: host, principal: actor }); }
  catch (error) { sendFailure(response, error); }
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

test('native questions pause real engine work, reject foreign/partial grants and resume with the real answer', async (t) => {
  const { host, context, events, results, question } = await fixture(t);
  assert.equal(context.engine.permissionBroker, null);
  assert.throws(() => context.ingress.start({ version: '1.0', type: 'permission_decision', request_id: 'bypass', permission_token: 'permission_a', choice: 'allow_once' }, owner), { code: 'unknown_control' });
  assert.equal((await call(host, '/question')).body[0].id, question.id);
  assert.equal(host.pendingRequests(owner).sessions.session_a.capabilities.forms, 'observe-only');
  assert.equal(events.find((event) => event.type === 'question.asked').properties.id, question.id);
  assert.deepEqual(host.questions({ ...owner, workspaceIds: ['workspace_a'] }), []);
  const path = `/question/${question.id}/reply`;
  assert.equal((await call(host, path, { ...owner, subjectId: 'foreign' }, { answers: [['stable']] })).status, 404);
  assert.equal((await call(host, path, { ...owner, permissions: ['nnd.read'] }, { answers: [['stable']] })).status, 403);
  assert.equal((await call(host, path, owner, { answers: [] })).status, 400);
  assert.equal(host.questions(owner).length, 1);
  assert.deepEqual(await call(host, path, owner, { answers: [['stable']] }), { status: 200, body: true });
  await until(() => host.statuses(owner).session_a === undefined);
  assert.deepEqual(host.questions(owner), []);
  assert.match(results[0].content, /stable/u); assert.match(results[0].content, /untrusted/u);
  assert.equal(events.find((event) => event.type === 'question.replied').properties.requestID, question.id);
  assert.equal((await call(host, path, owner, { answers: [['beta']] })).status, 404);
});

test('native question decline is honest denied speech and releases the pending form', async (t) => {
  const { host, events, results, question } = await fixture(t);
  assert.deepEqual(await call(host, `/question/${question.id}/reject`, owner, {}), { status: 200, body: true });
  await until(() => host.statuses(owner).session_a === undefined);
  assert.match(results[0].content, /denied/u); assert.equal(host.questions(owner).length, 0);
  assert.equal(events.find((event) => event.type === 'question.rejected').properties.requestID, question.id);
});

test('native turn cancellation releases the question and publishes rejection', async (t) => {
  const { host, events, question } = await fixture(t);
  await host.abort('session_a', owner); await until(() => host.statuses(owner).session_a === undefined);
  assert.equal(host.questions(owner).length, 0);
  assert.equal(events.find((event) => event.type === 'question.rejected').properties.requestID, question.id);
});

test('answer shape matches each form and supports every declared multiple-choice option', async () => {
  const broker = new QuestionBroker(); const controller = new AbortController();
  const waiting = broker.ask({ id: 'tool_a', args: { questions: [...args.questions, { question: 'Pick all', multiple: true,
    options: Array.from({ length: 16 }, (_, index) => ({ label: String(index) })) }] } }, controller.signal);
  const token = broker.snapshot()[0].token;
  for (const answers of [[['stable']], [['unknown'], ['0']], [['stable', 'beta'], ['0']], [['stable'], ['0', '0']]]) {
    assert.throws(() => broker.answer({ question_token: token, answers }, owner), { code: 'question_request_invalid' });
    assert.equal(broker.snapshot().length, 1);
  }
  const answers = [['stable'], Array.from({ length: 16 }, (_, index) => String(index))];
  broker.answer({ question_token: token, answers }, owner);
  assert.deepEqual(JSON.parse((await waiting).payload), answers);
});

test('native replies carry a maximal escaped answer matrix and reject oversized bodies without settlement', async () => {
  const broker = new QuestionBroker();
  const answers = Array.from({ length: 8 }, () => Array.from({ length: 16 }, (_, index) => `${index.toString(16)}${'\u0001'.repeat(255)}`));
  const waiting = broker.ask({ id: 'tool_large', args: { questions: answers.map((labels) => ({
    question: 'Select every label', multiple: true, options: labels.map((label) => ({ label })),
  })) } });
  const engine = { questionBroker: broker, decideQuestion: (command, principal) => broker.answer(command, principal) };
  const contexts = new Map([['session_large', { sessionId: 'session_large', subjectId: owner.subjectId,
    workspaceIds: owner.workspaceIds, engine, ingress: new CanonicalIngress(engine, { questions: true }) }]]);
  const host = { questions: (principal) => listNndQuestions(contexts, principal),
    settleQuestion: (...values) => settleNndQuestion(contexts, ...values) };
  const path = `/question/${broker.snapshot()[0].token}/reply`;
  assert.ok(Buffer.byteLength(JSON.stringify({ answers })) > 96 * 1024);
  const oversized = await call(host, path, owner, { answers, extra: 'x'.repeat(256 * 1024) });
  assert.equal(oversized.status, 400); assert.equal(oversized.body.error.code, 'request_too_large');
  assert.equal(broker.snapshot().length, 1);
  assert.deepEqual(await call(host, path, owner, { answers }), { status: 200, body: true });
  assert.deepEqual(JSON.parse((await waiting).payload), answers);
});
