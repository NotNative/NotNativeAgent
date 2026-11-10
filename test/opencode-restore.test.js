// SPDX-License-Identifier: Apache-2.0
// Failure-path tests for OpenCode session persistence: the durable index
// round-trip, boot-time restore through a real serve runtime, the
// close/remove distinction, and the skip-don't-fail behaviour of a corrupt
// session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { appendSessionIndex, readSessionIndex } from '../src/opencode/session-index.js';

class Provider {
  async *stream(request) {
    if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: 'restored ' }; yield { type: 'text', text: 'answer' };
    yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3 } };
    yield { type: 'terminal', finishReason: 'stop' };
  }
}

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

test('a stopped surface restores its sessions on the next boot', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-restore-'));
  const first = await durableServer(t, root);
  const session = (await (await first.request('/api/session', 'POST', { title: 'Survives restarts' })).json()).data;
  const prompt = await first.request(`/api/session/${session.id}/prompt`, 'POST', { text: 'persist me' });
  assert.equal(prompt.status, 200, await prompt.text());
  await first.request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const historyBefore = (await (await first.request(`/api/session/${session.id}/message`)).json()).data;
  assert.ok(historyBefore.some((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'text' && part.text === 'restored answer')));
  const ocId = session.id;
  // Why a hard stop, not the client route: this is the managed-runtime stop —
  // the process went away, the conversation did not.
  await first.runtime.stop();
  t.after(async () => { /* root removed by the shared after hook below */ });
  const second = await durableServer(t, root);
  const listed = (await (await second.request('/api/session')).json()).data;
  const restored = listed.find((entry) => entry.id === ocId);
  assert.ok(restored, `restored session list: ${JSON.stringify(listed)}`);
  assert.equal(restored.title, 'Survives restarts');
  const history = (await (await second.request(`/api/session/${ocId}/message`)).json()).data;
  assert.ok(history.some((message) => message.type === 'user' && message.text === 'persist me'));
  assert.ok(history.some((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'text' && part.text === 'restored answer')));
  assert.ok(history.some((message) => message.type === 'idle'));
  // Why the runtime stop summary: the operator's console record must show the
  // restore happened without reading the index file.
  assert.equal(second.runtime.restoreSummary.restored, 1);
  assert.equal(second.runtime.restoreSummary.skipped, 0);
  // A restored session keeps working: a live prompt continues the conversation.
  const followup = await second.request(`/api/session/${ocId}/prompt`, 'POST', { text: 'still alive' });
  assert.equal(followup.status, 200, await followup.text());
  await second.request(`/api/experimental/session/${ocId}/wait`, 'POST');
});

test('a client delete removes the durable identity; a surface stop does not', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-delete-'));
  const { runtime, request } = await durableServer(t, root);
  const kept = (await (await request('/api/session', 'POST', { title: 'Kept' })).json()).data;
  const gone = (await (await request('/api/session', 'POST', { title: 'Gone' })).json()).data;
  await request(`/api/session/${gone.id}`, 'DELETE');
  const index = await readSessionIndex(join(root, 's'));
  assert.ok(index.some((entry) => entry.ocId === kept.id));
  assert.ok(!index.some((entry) => entry.ocId === gone.id));
  // Why restart: the failure this pins is restore-after-delete resurrecting a
  // conversation the operator removed.
  await runtime.stop();
  const second = await durableServer(t, root);
  const listed = (await (await second.request('/api/session')).json()).data;
  assert.ok(listed.some((entry) => entry.id === kept.id));
  assert.ok(!listed.some((entry) => entry.id === gone.id));
});

test('a corrupt journal is skipped and the surface still boots', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-corrupt-'));
  const { runtime, request } = await durableServer(t, root);
  const good = (await (await request('/api/session', 'POST', { title: 'Good' })).json()).data;
  await runtime.stop();
  // Corrupt the recorded journal beyond recovery: garbage that no hash chain
  // can validate. The verified-prefix recovery of the store would still open
  // it, so instead corrupt the index entry to point at a missing journal —
  // the restore of that entry fails and the boot continues.
  const indexPath = join(root, 's', 'opencode-sessions.ndjson');
  const ghost = { schema: 'nna.opencode-session-index.v1', ocId: 'ses_ghost', sessionId: 'session_00000000-0000-0000-0000-000000000000', title: 'Ghost', createdAt: 1 };
  await appendFile(indexPath, `${JSON.stringify(ghost)}\n`);
  const second = await durableServer(t, root);
  const listed = (await (await second.request('/api/session')).json()).data;
  assert.ok(listed.some((entry) => entry.id === good.id), JSON.stringify(listed));
  assert.ok(!listed.some((entry) => entry.id === 'ses_ghost'));
  assert.equal(second.runtime.restoreSummary.skipped, 1);
});

test('a discovered pre-index journal restores under a fresh wire id', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-discover-'));
  const { runtime, request } = await durableServer(t, root);
  const session = (await (await request('/api/session', 'POST', { title: 'Old world' })).json()).data;
  const prompt = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'before the index' });
  assert.equal(prompt.status, 200);
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await runtime.stop();
  // Simulate the pre-index world: the journal exists but the index does not.
  await rm(join(root, 's', 'opencode-sessions.ndjson'), { force: true });

  const second = await durableServer(t, root);
  const listed = (await (await second.request('/api/session')).json()).data;
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.ok(listed[0].id.startsWith('ses_'));
  const history = (await (await second.request(`/api/session/${listed[0].id}/message`)).json()).data;
  assert.ok(history.some((message) => message.type === 'user' && message.text === 'before the index'));
  // Why the write-back: discovery must not rescan forever; the re-attach
  // claims the journal into the index for the next boot.
  const index = await readSessionIndex(join(root, 's'));
  assert.equal(index.length, 1);
});

test('conversations on one surface share one admission scheduler', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-scheduler-'));
  const { runtime, request } = await durableServer(t, root);
  const first = (await (await request('/api/session', 'POST', { title: 'One' })).json()).data;
  const second = (await (await request('/api/session', 'POST', { title: 'Two' })).json()).data;
  // Why identity, not behaviour: a behavioural serialization test would need a
  // concurrency-counting provider and a config whose provider concurrency is
  // 1; the scheduler identity is the contract this slice places, and the
  // FairScheduler's own tests already pin queueing and fairness behaviour.
  const engines = [...runtime.workspace.registry.list()].map((record) => record.engine);
  assert.equal(engines.length, 2, 'two conversations must be attached');
  assert.ok(engines[0].scheduler, 'a wired engine must carry a scheduler');
  assert.equal(engines[0].scheduler, engines[1].scheduler,
    'conversations on one surface must share the admission scheduler');
  assert.equal(engines[0].scheduler, runtime.workspace.scheduler,
    'the surface scheduler must be the scheduler the engines carry');
});
