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

class ParkProvider {
  calls = 0;
  async *stream(request) {
    this.calls += 1;
    if (this.calls === 1) {
      const args = { questions: [{ question: 'Deploy now?', options: [{ label: 'go' }] }] };
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'question-call', function: { name: 'question', arguments: encode(args) } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    this.unexpected = request;
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

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

test('POST /session/:id/abort settles a parked question and retires its token', async () => {
  const provider = new ParkProvider();
  const dirs = await roots('nna-wc-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider, directory: 'D:\\fixture-dir' }, async ({ url }) => {
    const created = await createSession(url);
    const frames = [];
    await openEventStream(url, frames);
    const turn = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Deploy the release' }] });
    const token = await parkQuestion(url, frames);
    const aborted = await postJson(url, `/session/${created.id}/abort`, {});
    assert.equal(aborted.status, 200);
    const ack = await aborted.json();
    assert.equal(ack.accepted, true);
    assert.equal(ack.aborted_prompts, 0);
    assert.ok(typeof ack.turn_id === 'string' && ack.turn_id.length > 0);
    const response = await turn;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).info.finish, 'abort');
    await waitForFrame(frames, (event) => event.type === 'session.idle', 'session.idle');
    const types = frames.map(frameOf).filter((event) => event.type !== 'sync').map((event) => event.type);
    const askedAt = types.indexOf('question.asked');
    const rejectedAt = types.indexOf('question.rejected');
    const idleAt = types.indexOf('session.idle');
    assert.ok(askedAt >= 0 && rejectedAt > askedAt && idleAt > rejectedAt, 'ask -> cancelled -> idle ordering');
    assert.equal(provider.calls, 1);
    const stale = await postJson(url, `/question/${token}/reply`, { answers: [['go']] });
    assert.equal(stale.status, 404);
  });
});

test('abort drains queued prompts and keeps the active turn settled', async () => {
  const provider = new ParkProvider();
  const dirs = await roots('nna-wc-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider }, async ({ url }) => {
    const created = await createSession(url);
    const frames = [];
    await openEventStream(url, frames);
    const first = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Deploy the release' }] });
    await parkQuestion(url, frames);
    const queued = postJson(url, `/session/${created.id}/message`, { parts: [{ type: 'text', text: 'Follow-up task' }] });
    await sleep(200);
    const aborted = await postJson(url, `/session/${created.id}/abort`, {});
    assert.equal(aborted.status, 200);
    assert.equal((await aborted.json()).aborted_prompts, 1);
    const firstResponse = await first;
    const queuedResponse = await queued;
    assert.equal((await firstResponse.json()).info.finish, 'abort');
    assert.equal((await queuedResponse.json()).info.finish, 'abort');
    assert.equal(provider.calls, 1);
    await waitForFrame(frames, (event) => event.type === 'session.idle', 'session.idle');
    const messages = await (await fetch(`${url}/session/${created.id}/message`, { headers: { connection: 'close' } })).json();
    assert.equal(messages.length, 4);
    assert.equal(messages[1].info.finish, 'abort');
    assert.equal(messages[2].info.role, 'user');
    assert.equal(messages[3].info.finish, 'abort');
  });
});

test('abort is idempotent on idle sessions and bare-404s unknown sessions', async () => {
  const provider = new ParkProvider();
  const dirs = await roots('nna-wc-');
  await serveDuring({ ...dirs, config: fixtureConfig(), providerFactory: () => provider }, async ({ url }) => {
    const created = await createSession(url);
    const idle = await postJson(url, `/session/${created.id}/abort`, {});
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { accepted: true, already_terminal: true, aborted_prompts: 0 });
    const missing = await postJson(url, '/session/ses_missing/abort', {});
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '');
  });
});
