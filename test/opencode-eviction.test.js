// SPDX-License-Identifier: Apache-2.0
// Idle eviction: an idle engine is shut down while its durable identity and
// listed history stay intact, and an arriving envelope re-attaches it through
// the boot-restore path. These tests pin the resource contract (the engine is
// really gone), the honesty contract (the session still lists), and the
// recovery contract (a prompt after eviction replays the journal).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { configureEviction, evictIdleSessions, stopEviction } from '../src/opencode/session-eviction.js';
import { readSessionIndex } from '../src/opencode/session-index.js';

async function durableServer(t, root, extra = {}) {
  const config = resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback',
  } });
  const runtime = await startOpencodeServe({ config, directory: root, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'),
    providerFactory: () => new Provider(), stdout: { write() {} }, ...extra });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const request = (path, method = 'GET', value, headers = {}) => fetch(`${runtime.url}${path}`, {
    method, headers: { connection: 'close', 'content-type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { runtime, request };
}

class Provider {
  async *stream(request) {
    if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: 'after eviction' };
    yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3 } };
    yield { type: 'terminal', finishReason: 'stop' };
  }
}

test('an idle session is evicted: engine released, identity kept, still listed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-evict-'));
  const { runtime, request } = await durableServer(t, root);
  const session = (await (await request('/api/session', 'POST', { title: 'Evict me' })).json()).data;
  await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'work once' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const engineBefore = runtime.workspace.registry.get(session.id).engine;
  assert.ok(engineBefore, 'the session is live before eviction');
  // Why configure: serve defaults eviction off; this test drives the pass
  // directly, so the workspace needs an eviction state with a real threshold.
  configureEviction(runtime.workspace.core, { idleMs: 60_000 });
  // Force the idle clock past any threshold: the registry stamps updatedAt
  // from createdAt on attach, so backdating createdAt is the honest way.
  const record = runtime.workspace.registry.get(session.id);
  runtime.workspace.registry.remove(session.id);
  runtime.workspace.registry.attach({ ...record, createdAt: Date.now() - 10 * 60_000 });
  const evicted = await evictIdleSessions(runtime.workspace.core);
  assert.deepEqual(evicted, [session.id]);
  const dormant = runtime.workspace.registry.get(session.id);
  assert.equal(dormant.evicted, true, 'the registry keeps a dormant record');
  assert.equal(dormant.engine, null, 'the engine is released');
  // Why the index check: the durable identity is what demand re-attach reads.
  const index = await readSessionIndex(join(root, 's'));
  assert.ok(index.some((entry) => entry.ocId === session.id), 'the durable identity stays');
  // The listed session still exists for the client.
  const listed = (await (await request('/api/session')).json()).data;
  assert.ok(listed.some((entry) => entry.id === session.id), 'the conversation is still listed');
});

test('a prompt after eviction re-attaches and continues the conversation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reattach-'));
  const { runtime, request } = await durableServer(t, root);
  const session = (await (await request('/api/session', 'POST', { title: 'Come back' })).json()).data;
  await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'persist me' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  // Evict by backdating the idle clock, then prompt again.
  configureEviction(runtime.workspace.core, { idleMs: 60_000 });
  const record = runtime.workspace.registry.get(session.id);
  runtime.workspace.registry.remove(session.id);
  runtime.workspace.registry.attach({ ...record, createdAt: Date.now() - 10 * 60_000 });
  await evictIdleSessions(runtime.workspace.core);
  assert.equal(runtime.workspace.registry.get(session.id).evicted, true);
  const prompt = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'still alive' });
  assert.equal(prompt.status, 200, await prompt.text());
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const live = runtime.workspace.registry.get(session.id);
  assert.equal(live.evicted, undefined, 'the session re-attached live');
  assert.ok(live.engine, 'a live engine exists again');
  const history = (await (await request(`/api/session/${session.id}/message`)).json()).data;
  assert.ok(history.some((message) => message.type === 'user' && message.text === 'persist me'),
    'the pre-eviction history survived');
  assert.ok(history.some((message) => message.type === 'assistant' && message.content.some(
    (part) => part.type === 'text' && part.text === 'after eviction')), 'the new turn answered');
});

test('configureEviction validates its threshold and can disable itself', async (t) => {
  const workspace = { registry: { list: () => [] } };
  assert.throws(() => configureEviction(workspace, { idleMs: 999 }), RangeError);
  assert.throws(() => configureEviction(workspace, { idleMs: 25 * 3_600_000 }), RangeError);
  const disabled = configureEviction(workspace, { idleMs: 0 });
  assert.equal(disabled.idleMs, 0);
  assert.equal(disabled.timer, null);
  stopEviction(workspace);
});
