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

test('a restored session reports the model it ran at, not the surface default', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-restore-model-'));
  const first = await durableServer(t, root);
  const session = (await (await first.request('/api/session', 'POST', { title: 'Model identity' })).json()).data;
  assert.equal(session.model.id, 'fixture-model', JSON.stringify(session.model));
  const prompt = await first.request(`/api/session/${session.id}/prompt`, 'POST', { text: 'remember the model' });
  assert.equal(prompt.status, 200, await prompt.text());
  await first.request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await first.runtime.stop();

  // Why a *different* configured route on the second boot: this is the failure
  // being pinned. A restore that reads the configured route reports a model the
  // conversation never used, so an operator reopening it sees the conversation
  // silently re-pointed at whatever the surface is configured with now.
  const second = await durableServer(t, root, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'rotated', endpoint: 'http://127.0.0.1:9999/v1', model: 'rotated-model', trust_zone: 'loopback' } }) });
  const restored = (await (await second.request('/api/session')).json()).data
    .find((entry) => entry.id === session.id);
  assert.ok(restored, 'the session must restore');
  assert.equal(restored.model.id, 'fixture-model',
    `a restored session must keep its model, got ${JSON.stringify(restored.model)}`);
  assert.equal(restored.model.providerID, 'test');
  // And the record read agrees with the list, which is what the client uses when
  // it opens a conversation rather than scrolling the sidebar.
  const single = (await (await second.request(`/api/session/${session.id}`)).json()).data;
  assert.equal(single.model.id, 'fixture-model');
});

test('a model switch is durable across a restart', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-restore-switch-'));
  const first = await durableServer(t, root);
  const session = (await (await first.request('/api/session', 'POST', { title: 'Switched' })).json()).data;
  // Why the index rather than the API: this surface exposes one selectable model
  // in the fixed-provider case, so a switch is recorded through the same durable
  // write the selection path uses. The failure being pinned is that the write
  // did not happen at all, so a restart lost the choice.
  const { updateSessionIndex } = await import('../src/opencode/session-index.js');
  await updateSessionIndex(join(root, 's'), session.id,
    { model: { id: 'switched-model', providerID: 'test', variant: 'high' } });
  await first.runtime.stop();

  const second = await durableServer(t, root);
  const restored = (await (await second.request(`/api/session/${session.id}`)).json()).data;
  assert.equal(restored.model.id, 'switched-model', JSON.stringify(restored.model));
  // Compatibility: the thinking level travels with the model, because a client
  // renders them together and a restored session that dropped the level would
  // show a level the next prompt does not use.
  assert.equal(restored.model.variant, 'high');
});

test('an index entry with no model restores on the configured route', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-restore-legacy-'));
  const first = await durableServer(t, root);
  const session = (await (await first.request('/api/session', 'POST', { title: 'Pre-model' })).json()).data;
  await first.request(`/api/session/${session.id}/prompt`, 'POST', { text: 'older entry' });
  await first.request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await first.runtime.stop();
  // Why strip the field: an index written by a build before the model was
  // recorded must still restore. Refusing it, or reporting an undefined model,
  // would strand every conversation an operator already had.
  const indexPath = join(root, 's', 'opencode-sessions.ndjson');
  const lines = (await readFile(indexPath, 'utf8')).split('\n').filter(Boolean);
  await writeFile(indexPath, `${lines.map((line) => {
    const record = JSON.parse(line); delete record.model; return JSON.stringify(record);
  }).join('\n')}\n`);

  const second = await durableServer(t, root);
  const restored = (await (await second.request(`/api/session/${session.id}`)).json()).data;
  assert.equal(restored.model.id, 'fixture-model', JSON.stringify(restored.model));
  assert.equal(restored.model.providerID, 'test');
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

test('conversations on one surface resolve in one conversation family', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-family-'));
  const { runtime, request } = await durableServer(t, root);
  await request('/api/session', 'POST', { title: 'Alpha' });
  await request('/api/session', 'POST', { title: 'Beta' });
  // Why this pins the central-engine shape: the surface is a client of one
  // conversation registry; every wired engine joined it at construction, so
  // the surface resolves any attached conversation's state by session id.
  // Note the two id spaces: the wire uses ses_* ocIds, the registry uses the
  // engines' session_* ids.
  const family = runtime.workspace.conversations;
  const engines = [...runtime.workspace.registry.list()].map((record) => record.engine);
  assert.equal(engines.length, 2, 'two conversations are attached');
  assert.equal(family.size(), 2, 'both engines joined the surface registry');
  for (const engine of engines) {
    assert.ok(family.has(engine.sessionId), `missing ${engine.sessionId}`);
    assert.equal(family.resolve(engine.sessionId).transcript, engine.transcript,
      'the surface registry and the owning engine agree on identity');
  }
});

test('surface diagnostics report the shared scheduler held state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-diag-'));
  const { runtime, request } = await durableServer(t, root);
  await request('/api/session', 'POST', { title: 'Observed' });
  const diagnostics = runtime.diagnostics();
  assert.ok(diagnostics.scheduler, 'diagnostics must report the scheduler');
  assert.ok(Array.isArray(diagnostics.scheduler), 'the report is a per-route snapshot');
  const engineScheduler = [...runtime.workspace.registry.list()].map((record) => record.engine.scheduler)[0];
  assert.equal(engineScheduler, runtime.workspace.scheduler, 'one scheduler serves the surface');
});
