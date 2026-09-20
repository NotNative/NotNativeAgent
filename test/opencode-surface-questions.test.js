// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';

function fixtureConfig() {
  return resolveManifest({
    persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  });
}

function encode(value) { return JSON.stringify(value); }

function questionFragments() {
  const args = { questions: [{ question: 'Which channel?', options: [{ label: 'stable' }, { label: 'beta' }] }] };
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id: 'question-call', function: { name: 'question', arguments: encode(args) } }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

function finishFragments() {
  const args = { outcome: 'completed' };
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish-call', function: { name: 'turn_finish', arguments: encode(args) } }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

class QuestionProvider {
  #seen = [];
  get toolContents() { return this.#seen; }
  async *stream(request) {
    const messages = request.messages ?? [];
    const toolReply = messages.find((message) => message.role === 'tool');
    if (toolReply === undefined) { yield* questionFragments(); return; }
    if (!this.#seen.includes(toolReply.content)) this.#seen.push(toolReply.content);
    if (messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'text', text: 'deploying on stable' };
      yield { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
      return;
    }
    yield* finishFragments();
  }
}

function decode(text) { return JSON.parse(text); }

async function serveDuring(options, run) {
  const runtime = await startOpencodeServe({ ...options, stdout: { write: () => undefined }, handshakeSink: async () => undefined });
  try { return await run({ runtime, url: runtime.url }); } finally { await runtime.stop(); }
}

async function roots(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  return { storeRoot: join(base, 's'), reviewerRoot: join(base, 'r') };
}

async function createSession(url) {
  const response = await fetch(`${url}/session`, {
    method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
    body: encode({ title: 'question-bench' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}


async function openEventStream(url, collector) {
  const response = await fetch(`${url}/global/event`, { headers: { connection: 'close', accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const timeout = setTimeout(() => reader.cancel().catch(() => {}), 20_000);
  const session = { reader, pending: '', frames: collector, done: false };
  void collectFrames(session).finally(() => clearTimeout(timeout));
  await raceForConnected(session);
  return session;
}

function frameOf(event) {
  return JSON.parse(event).payload;
}

function isIdleFrame(frame) {
  return frame?.type === 'session.idle';
}

async function raceForConnected(session) {
  const deadline = Date.now() + 5_000;
  while (!session.frames.some((frame) => frameOf(frame)?.type === 'server.connected') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(session.frames.some((frame) => frameOf(frame)?.type === 'server.connected'), 'opener frame must arrive on subscribe');
}

async function collectFrames(session) {
  for (;;) {
    const read = await session.reader.read();
    if (read.done) break;
    session.pending += String(Buffer.from(read.value).toString('utf8'));
    for (;;) {
      const index = session.pending.indexOf('\n\n');
      if (index < 0) break;
      const block = session.pending.slice(0, index);
      session.pending = session.pending.slice(index + 2);
      if (block.startsWith('data: ')) session.frames.push(block.slice('data: '.length));
    }
    if (session.frames.some((frame) => isIdleFrame(frameOf(frame))) && session.settled !== true) {
      session.settled = true;
      void session.reader.cancel().catch(() => {});
    }
  }
  session.done = true;
}
async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForFrame(frames, predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    const found = frames.map(frameOf).find((event) => event !== undefined && predicate(event));
    if (found !== undefined) return found;
    await sleep(40);
  }
  throw new Error('timed out waiting for ' + label);
}

async function postJson(url, path, body) {
  return fetch(url + path, {
    method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
    body: encode(body ?? {}),
  });
}

async function parkQuestion(url, frames) {
  const asked = await waitForFrame(frames, (event) => event.type === 'question.asked', 'question.asked');
  return asked.properties.question_token;
}

test('question.asked parks the turn and /question/:id/reply resumes it', async () => {
  const provider = new QuestionProvider();
  const dirs = await roots('nna-wq-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider, directory: 'D:\\fixture-dir' }, async ({ url }) => {
    const created = await createSession(url);
    const frames = [];
    await openEventStream(url, frames);
    const turn = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Deploy the release' }] });
    const token = await parkQuestion(url, frames);
    assert.ok(token.startsWith('que_'));
    const replied = await postJson(url, `/question/${token}/reply`, { answers: [['stable']] });
    assert.equal(replied.status, 200);
    assert.deepEqual(await replied.json(), { accepted: true, question_token: token, answers: [['stable']] });
    const response = await turn;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.info.role, 'assistant');
    assert.equal(body.info.finish, 'stop');
    assert.deepEqual(provider.toolContents.map((text) => decode(text).content), [encode([['stable']])]);
    assert.equal(decode(provider.toolContents[0]).tool_lifecycle_status, 'succeeded');
    await waitForFrame(frames, (event) => event.type === 'session.idle', 'session.idle');
    const types = frames.map(frameOf).filter((event) => event.type !== 'sync').map((event) => event.type);
    const askedAt = types.indexOf('question.asked');
    const repliedAt = types.indexOf('question.replied');
    const idleAt = types.indexOf('session.idle');
    assert.ok(askedAt >= 0 && repliedAt > askedAt && idleAt > repliedAt, 'ask -> reply -> idle ordering');
    const askedFrame = frames.map(frameOf).find((event) => event.type === 'question.asked');
    assert.equal(askedFrame.properties.questions[0].options.length, 2);
    assert.equal(askedFrame.properties.sessionID, created.id);
  });
});

test('question reject settles as operator speech and retires the token', async () => {
  const provider = new QuestionProvider();
  const dirs = await roots('nna-wq-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider }, async ({ url }) => {
    const created = await createSession(url);
    const frames = [];
    await openEventStream(url, frames);
    const turn = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Deploy the release' }] });
    const token = await parkQuestion(url, frames);
    const rejected = await postJson(url, `/question/${token}/reject`, {});
    assert.equal(rejected.status, 200);
    assert.deepEqual(await rejected.json(), { accepted: true, question_token: token, declined: true });
    const response = await turn;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).info.role, 'assistant');
    assert.equal(decode(provider.toolContents[0]).content, 'The user dismissed this question');
    await waitForFrame(frames, (event) => event.type === 'question.rejected', 'question.rejected');
    const stale = await postJson(url, `/question/${token}/reply`, { answers: [['stable']] });
    assert.equal(stale.status, 404);
    assert.equal(await stale.text(), '');
  });
});

test('question routes fail loud on unknown tokens, bad matrices, and media gates', async () => {
  const provider = new QuestionProvider();
  const dirs = await roots('nna-wq-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider }, async ({ url }) => {
    const missing = await postJson(url, '/question/que_missing/reply', { answers: [['stable']] });
    assert.equal(missing.status, 404);
    const created = await createSession(url);
    const frames = [];
    await openEventStream(url, frames);
    const turn = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Deploy the release' }] });
    const token = await parkQuestion(url, frames);
    const noMedia = await fetch(`${url}/question/${token}/reply`, { method: 'POST', headers: { connection: 'close' }, body: '{}' });
    assert.equal(noMedia.status, 415);
    const malformed = await postJson(url, `/question/${token}/reply`, { answers: 'stable' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).name, 'UnknownError');
    const good = await postJson(url, `/question/${token}/reply`, { answers: [['beta']] });
    assert.equal(good.status, 200);
    assert.equal((await turn).status, 200);
  });
});
