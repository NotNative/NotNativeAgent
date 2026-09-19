// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { WIRED_OPENCODE_VERSION } from '../src/opencode/version.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixtureConfig() {
  return resolveManifest({
    persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  });
}

class ScriptedProvider {
  async *stream(request) {
    if (!hasFinishCall(request)) { yield* finishCall('completed'); return; }
    yield { type: 'text', text: 'bench' };
    yield { type: 'text', text: '-ok' };
    yield { type: 'usage', usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

function finishCall(outcome) {
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id: `finish-${outcome}`, function: { name: 'turn_finish', arguments: JSON.stringify({ outcome }) } }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

function hasFinishCall(request) {
  return request.messages?.some((message) => message.tool_calls
    ?.some((call) => call.function?.name === 'turn_finish')) === true;
}

async function serveDuring(options, run) {
  const handshake = [];
  const runtime = await startOpencodeServe({ ...options, stdout: { write: () => undefined }, handshakeSink: async (line) => handshake.push(line) });
  try { return await run({ runtime, url: runtime.url, handshake }); }
  finally { await runtime.stop(); }
}

async function createSession(url) {
  const response = await fetch(`${url}/session`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'prompt-bench' }) });
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

test('prompt lifecycle drives the full wire cadence over /global/event', async () => {
  await serveDuring({
    config: fixtureConfig(), providerFactory: () => new ScriptedProvider(),
    storeRoot: join(await mkdtemp(join(tmpdir(), 'nna-prompt-')), 's'), reviewerRoot: join(await mkdtemp(join(tmpdir(), 'nna-prompt-')), 'r'),
    directory: 'D:\\fixture-dir',
  }, async ({ url }) => {
    const created = await createSession(url);
    const frames = [];
    const session = await openEventStream(url, frames);
    const response = await fetch(`${url}/session/${created.id}/message`, {
      method: 'POST',
      headers: { connection: 'close', 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Reply with exactly: bench-ok' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.info.role, 'assistant');
    assert.equal(body.info.finish, 'stop');
    assert.deepEqual(Object.keys(body).sort(), ['info', 'parts']);
    assert.deepEqual(body.parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
    assert.equal(body.parts[1].text, 'bench-ok');
    assert.deepEqual(body.info.tokens, { total: 40, input: 32, output: 8, reasoning: 0, cache: { read: 0, write: 0 } });
    // Cadence: idle sentinel arrives and matches the observed gold flow.
    const deadline = Date.now() + 20_000;
    while (!frames.some((frame) => isIdleFrame(frameOf(frame))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const events = frames.map((frame) => frameOf(frame));
    const bare = [];
    for (const event of events) if (event.type !== 'sync' && !bare.includes(event.type)) bare.push(event.type);
    const expected = ['server.connected', 'session.updated', 'message.updated', 'message.part.updated', 'session.status', 'message.part.delta', 'session.idle', 'session.diff'];
    for (const type of expected) assert.ok(bare.includes(type), `missing event type ${type}`);
    assert.ok(events.filter((event) => event.type === 'message.part.delta').length >= 2, 'deltas stream through the wire');
    const idleIndex = events.findIndex((event) => event.type === 'session.idle');
    assert.ok(idleIndex > 0, 'idle sentinel must trail the assistant events');
    const assistantBeforeIdle = events.findIndex((event) => event.type === 'message.updated');
    assert.ok(assistantBeforeIdle >= 0 && assistantBeforeIdle < idleIndex, 'assistant durability lands before the idle sentinel');
    assert.equal(session.done, true, 'collector settled on idle');
    const messages = await (await fetch(`${url}/session/${created.id}/message`, { headers: { connection: 'close' } })).json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].info.role, 'user');
    assert.deepEqual(messages[0].info.summary, { diffs: [] });
    assert.equal(messages[0].parts[0].text, 'Reply with exactly: bench-ok');
    assert.equal(messages[1].info.role, 'assistant');
    assert.deepEqual(messages[1].parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
    assert.equal(messages[1].parts[1].text, 'bench-ok');
    const removed = await fetch(`${url}/session/${created.id}`, { method: 'DELETE', headers: { connection: 'close' } });
    assert.equal(removed.status, 200);
    assert.equal(await removed.json(), true);
  });
});

test('prompt routes fail loud on media and unknown sessions like the gold wire', async () => {
  await serveDuring({
    config: fixtureConfig(), providerFactory: () => new ScriptedProvider(),
    storeRoot: join(await mkdtemp(join(tmpdir(), 'nna-prompt-')), 's'), reviewerRoot: join(await mkdtemp(join(tmpdir(), 'nna-prompt-')), 'r'),
  }, async ({ url }) => {
    const mismatched = await fetch(`${url}/session/ses_x/message`, { method: 'POST', headers: { connection: 'close' }, body: JSON.stringify({ parts: [] }) });
    assert.equal(mismatched.status, 415);
    assert.equal(await mismatched.text(), 'Unsupported content-type: text/plain;charset=UTF-8');
    const missing = await fetch(`${url}/session/_missing_/message`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });
    assert.equal(missing.status, 500);
    const envelope = await missing.json();
    assert.equal(envelope.name, 'UnknownError');
    assert.ok(typeof envelope.data.message === 'string');
    assert.match(envelope.data.ref, /^err_[0-9a-f]+$/u);
    assert.equal(WIRED_OPENCODE_VERSION, '1.18.31');
  });
});
