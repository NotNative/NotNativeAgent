// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { observeV1Event } from '../src/opencode/v2-projection.js';
import { MINIMUM_OPENCODE_VERSION, WIRED_OPENCODE_VERSION } from '../src/opencode/version.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/opencode/v2-schemas.json', import.meta.url)));

test('v2 projects scoped compaction lifecycle as a live extension event', () => {
  const emitted = [];
  const state = { info: { id: 'ses_a' }, active: { assistantId: 'msg_a' } };
  observeV1Event(state, { type: 'nna.context.compaction', properties: {
    sessionID: 'ses_a', turnID: 'turn_a', status: 'completed',
    beforeEstimatedTokens: 30_000, afterEstimatedTokens: 18_000,
  } }, { emit: (_state, type, data, durable) => emitted.push({ type, data, durable }) });
  assert.deepEqual(emitted, [
    { type: 'nna.context.compaction', data: {
      sessionID: 'ses_a', turnID: 'turn_a', status: 'completed',
      beforeEstimatedTokens: 30_000, afterEstimatedTokens: 18_000,
    }, durable: false },
    // Compatibility: a client announces a finished compaction only from this
    // event and has no case for the extension above.
    { type: 'session.compaction.ended', data: { sessionID: 'ses_a' }, durable: false },
  ]);
});

test('v2 announces only a settled compaction, and only during a turn', () => {
  const run = (status, active) => {
    const emitted = [];
    observeV1Event({ info: { id: 'ses_a' }, ...(active ? { active: { assistantId: 'msg_a' } } : {}) },
      { type: 'nna.context.compaction', properties: { sessionID: 'ses_a', status } },
      { emit: (_state, type) => emitted.push(type) });
    return emitted;
  };
  // An in-flight or skipped compaction did not compact, so it is not announced.
  assert.deepEqual(run('started', true), ['nna.context.compaction']);
  assert.deepEqual(run('skipped', true), ['nna.context.compaction']);
  // A settled compaction outside a live turn has no transcript to land in.
  assert.deepEqual(run('completed', false), ['nna.context.compaction']);
  assert.deepEqual(run('failed', true), ['nna.context.compaction', 'session.compaction.ended']);
});

function schemaCheck(value, schema) {
  if (schema.$ref) return schemaCheck(value, fixture.components.schemas[schema.$ref.split('/').at(-1)]);
  if (schema.anyOf) return schema.anyOf.some((item) => schemaCheck(value, item));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
    && value.every((item, index) => schemaCheck(item, schema.prefixItems?.[index] ?? schema.items ?? {}));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.required?.some((key) => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? schemaCheck(item, schema.properties[key]) : schema.additionalProperties === false ? false
        : typeof schema.additionalProperties === 'object' ? schemaCheck(item, schema.additionalProperties) : true);
  }
  if (schema.type === 'integer') return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity);
  if (schema.type && typeof value !== schema.type) return false;
  return !schema.pattern || new RegExp(schema.pattern, 'u').test(value);
}

function contract(name, value) {
  assert.ok(schemaCheck(value, fixture.components.schemas[name]), `${name}: ${JSON.stringify(value)}`);
}

class Provider {
  async *stream(request) {
    if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: 'hello ' }; yield { type: 'text', text: 'v2' };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 4 } };
    yield { type: 'terminal', finishReason: 'stop' };
  }
}

/** Fails the turn at the provider so the engine reports a failed outcome.
 *  Why the fixed code: only guidance, never provider exception text, may cross
 *  the wire, and this exercises the credential-guidance branch. */
class FailingProvider extends Provider {
  async *stream() { throw Object.assign(new Error('provider-secret-should-not-leak'), { code: 'missing_credential' }); }
}

async function fixtureServer(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-v2-'));
  const config = resolveManifest({ persistence: 'ephemeral', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback',
  } });
  const runtime = await startOpencodeServe({ config, directory: root, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'),
    providerFactory: () => new Provider(), stdout: { write() {} }, ...extra });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const request = (path, method = 'GET', value, headers = {}) => fetch(`${runtime.url}${path}`, {
    method, headers: { connection: 'close', 'content-type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const json = async (...args) => { const response = await request(...args); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  return { runtime, request, json, root };
}

test('legacy creation cannot supply internal v2 session authority fields', async (t) => {
  const { json, runtime } = await fixtureServer(t);
  const session = await json('/session', 'POST', {
    title: 'Legacy', ocId: 'ses_injected', runtimeDirectory: 'D:\\unauthorized', metadata: { injected: true },
  });
  assert.notEqual(session.id, 'ses_injected');
  const record = runtime.workspace.registry.get(session.id);
  assert.notEqual(record.engine.config.workspaceRoot, 'D:\\unauthorized');
});

test('v2 prompt accepts text beyond the old 65536-character ceiling', async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const prompt = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'a'.repeat(70_000) });
  assert.equal(prompt.status, 200, await prompt.text());
  assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'succeeded');
});

test('every v2 event carries the flat envelope the client reads', { timeout: 20_000 }, async (t) => {
  // Why: the client's translateWireEvent reads payload.type / payload.created /
  // payload.data. A nested `properties` envelope (the v1 shape) would parse as an
  // unknown event and be dropped, so the whole turn would vanish from the GUI.
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'hello' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await waitForEvent(events, 'session.execution.succeeded');
  await controller.abort();
  await collected;
  assert.ok(events.length > 4);
  for (const event of events) {
    assert.equal(typeof event.type, 'string', 'every event names its type at the top level');
    assert.equal(typeof event.created, 'number', `${event.type} carries a top-level created`);
    assert.equal(typeof event.data, 'object', `${event.type} carries its payload under data`);
    // The v1 shape must never leak in beside it.
    assert.equal('payload' in event, false, `${event.type} must not carry a v1 payload`);
    assert.equal('properties' in event, false, `${event.type} must not carry a v1 properties`);
  }
  // The turn's own events name the session under data, where the client reads it.
  const sessionEvents = events.filter((event) => event.data?.sessionID === session.id);
  assert.ok(sessionEvents.length > 0, 'events identify their session under data.sessionID');
});

test('v2 stages a revert at a client message and clears it again', { timeout: 30_000 }, async (t) => {
  // Why: the engine resolves a revert boundary by its own request id, while the
  // client names the message it supplied. The wire session holds that join, so a
  // revert must work from the client's id and restore on clear.
  //
  // Durable persistence is required: the engine's revert is journal-backed and
  // refuses an ephemeral store rather than pretending to hide a turn.
  const { json, request } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_r1', text: 'first' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const before = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  assert.equal(before.length, 3);

  const staged = await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_r1' });
  assert.equal(staged.status, 200);
  const body = (await staged.json()).data;
  // The client reads a `Session.Revert`, whose required field is `messageID`.
  assert.equal(body.messageID, 'msg_r1');

  // Clearing the marker restores the timeline.
  assert.equal((await request(`/api/session/${session.id}/revert`, 'DELETE')).status, 204);

  // An unknown message is refused rather than staging a boundary that would not
  // resolve, and a body naming fields the route does not accept is refused too.
  assert.equal((await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_absent' })).status, 404);
  assert.equal((await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_r1', files: 'yes' })).status, 400);
});

test('v2 announces staged, cleared and committed reverts on the event stream', { timeout: 30_000 }, async (t) => {
  // Why: the client renders revert state only from these events. The engine
  // mutates its timeline silently, so without them a revert happened on the
  // server and the GUI never showed it.
  const { json, request, runtime } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_rv', text: 'first' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');

  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();

  assert.equal((await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_rv' })).status, 200);
  const staged = await waitForEvent(events, 'session.revert.staged');
  assert.equal(staged.data.sessionID, session.id);
  // The client sets session.info[id].revert from this payload.
  assert.deepEqual(staged.data.revert, { messageID: 'msg_rv' });

  assert.equal((await request(`/api/session/${session.id}/revert`, 'DELETE')).status, 204);
  const cleared = await waitForEvent(events, 'session.revert.cleared');
  assert.equal(cleared.data.sessionID, session.id);

  // A commit keeps the revert and drops the client's staged affordance.
  assert.equal((await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_rv' })).status, 200);
  assert.equal((await request(`/api/session/${session.id}/revert/commit`, 'POST')).status, 204);
  const committed = await waitForEvent(events, 'session.revert.committed');
  assert.equal(committed.data.sessionID, session.id);
  assert.equal(committed.data.to, 'msg_rv');
  await controller.abort();
  await collected;
});

test('manual compaction answers a full inbox record and announces the lifecycle', { timeout: 40_000 }, async (t) => {
  // Why: the client admits a compaction locally and waits for these events to move
  // the bubble out of `status: running`; the engine's operator compaction emits
  // nothing, so a surface that only compacts leaves the GUI spinning forever.
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_cp1', text: 'first' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');

  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();

  const compacted = (await json(`/api/session/${session.id}/compact`, 'POST', { id: 'msg_compact01' })).data;
  // The client admits this record under its own id and joins it to the events by
  // that id; anything else leaves both a stray bubble and an unjoined event.
  contract('Session.Inbox.Compaction', compacted);

  const started = await waitForEvent(events, 'session.compaction.started');
  assert.equal(started.data.sessionID, session.id);
  assert.equal(started.data.reason, 'manual');
  assert.equal(started.data.inputID, 'msg_compact01');
  const ended = await waitForEvent(events, 'session.compaction.ended');
  assert.equal(ended.data.sessionID, session.id);
  assert.equal(ended.data.reason, 'manual');
  // The client keeps the running compaction under inputID and writes `text` onto it
  // when the turn ends, so a mismatch would leave the original bubble running.
  assert.equal(ended.data.inputID, 'msg_compact01');
  assert.equal(typeof ended.data.text, 'string');
  await controller.abort();
  await collected;

  // The finished compaction stays in history, so a client that reloads still sees
  // why the transcript shrank rather than an unexplained gap between turns.
  const ledger = (await json(`/api/session/${session.id}/message`)).data
    .find((item) => item.type === 'compaction');
  contract('Session.Message.Compaction.Completed', ledger);
  assert.equal(ledger.id, 'msg_compact01');

  // An omitted id is minted, not left undefined: the client reads the record's id
  // before it has any event to join to.
  const minted = (await json(`/api/session/${session.id}/compact`, 'POST', {})).data;
  assert.match(minted.id, /^msg_/u);
  assert.equal(minted.delivery, 'steer');
});

test('manual compaction refuses bad input, a busy session, and reports its failure', { timeout: 40_000 }, async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;

  // A delivery the client does not have, a field the route does not accept, and an
  // id from another namespace are each refused with the 400 the SDK declares.
  assert.equal((await request(`/api/session/${session.id}/compact`, 'POST', { delivery: 'later' })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/compact`, 'POST', { text: 'compact please' })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/compact`, 'POST', { id: 'ses_wrong' })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/compact`, 'POST', { delivery: 'steer' })).status, 200);
  assert.equal((await request('/api/session/ses_missing/compact', 'POST', {})).status, 404);

  // The client renders a conflict as guidance, so the engine's own busy refusal has
  // to reach it as 409 ConflictError rather than an opaque 500.
  const engine = runtime.workspace.registry.get(session.id).engine;
  engine.state.transition('preparing_turn', { trigger: 'test_busy' });
  try {
    const busy = await request(`/api/session/${session.id}/compact`, 'POST', {});
    assert.equal(busy.status, 409);
    assert.equal((await busy.json())._tag, 'ConflictError');
  } finally { engine.state.transition('finalizing_turn', { trigger: 'test_busy_done' }); }

  // Why the journal: a failed compaction is the one path where the engine's own
  // durability speaks, and it fails before the model runs, so this exercises the
  // failure event without depending on provider behaviour.
  const durableRoot = await mkdtemp(join(tmpdir(), 'nna-v2-cfail-'));
  const durableConfig = resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } });
  const durable = await startOpencodeServe({ config: durableConfig, directory: durableRoot,
    storeRoot: join(durableRoot, 's'), reviewerRoot: join(durableRoot, 'r'),
    providerFactory: () => new Provider(), stdout: { write() {} } });
  t.after(async () => { await durable.stop(); await rm(durableRoot, { recursive: true, force: true }); });
  const call = (path, value) => fetch(`${durable.url}${path}`, {
    method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const wired = (await (await call('/api/session', {})).json()).data;

  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = await fetch(`${durable.url}/api/event`, { signal: controller.signal });
  const reader = stream.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();

  const target = durable.workspace.registry.get(wired.id).engine.store;
  const original = target.append.bind(target);
  target.append = async (type, payload) => (type === 'compaction_snapshot'
    ? Promise.reject(Object.assign(new Error('journal-secret-should-not-leak'), { code: 'journal_write_failed' }))
    : original(type, payload));
  const failed = await call(`/api/session/${wired.id}/compact`, { id: 'msg_compactfail' });
  target.append = original;
  assert.equal(failed.status, 500);
  assert.equal((await failed.json())._tag, 'UnknownError');

  const started = await waitForEvent(events, 'session.compaction.started');
  assert.equal(started.data.inputID, 'msg_compactfail');
  const failure = await waitForEvent(events, 'session.compaction.failed');
  assert.equal(failure.data.sessionID, wired.id);
  assert.equal(failure.data.inputID, 'msg_compactfail');
  // The client writes this straight onto the failed record.
  assert.equal(typeof failure.data.error.type, 'string');
  assert.equal(typeof failure.data.error.message, 'string');
  // Security: the exception text stays on the server.
  assert.doesNotMatch(JSON.stringify(failure.data.error), /journal-secret-should-not-leak/u);
  // A failed compaction is not a compaction: nothing lands in history.
  const ledger = await fetch(`${durable.url}/api/session/${wired.id}/message`, { headers: { connection: 'close' } });
  assert.equal(((await ledger.json()).data ?? []).some((item) => item.type === 'compaction'), false);
  await controller.abort();
  await collected;
});

test('a revert on an ephemeral session is refused rather than faked', { timeout: 20_000 }, async (t) => {
  // Invariant: the engine's revert needs a journal. A surface that answered 200
  // here would claim to have hidden a turn it cannot restore.
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_e1', text: 'first' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const denied = await request(`/api/session/${session.id}/revert/stage`, 'POST', { messageID: 'msg_e1' });
  assert.equal(denied.status, 500);
  assert.equal((await denied.json())._tag, 'UnknownError');
});

test('the agent catalog contains exactly the build agent every send names', async (t) => {
  // Why: before a send, the client looks the requested agent up in this catalog
  // and throws AgentUnavailableError when the catalog is non-empty and lacks it.
  // Advertising an extra agent would therefore be harmless, but advertising a
  // different id than the one sessions and prompts use would block every send.
  const { json, request } = await fixtureServer(t);
  const agents = (await json('/api/agent')).data;
  assert.equal(Array.isArray(agents), true);
  assert.deepEqual(agents.map((agent) => agent.id), ['build']);
  assert.equal(agents[0].mode, 'primary');
  assert.equal(agents[0].hidden, false);
  contract('Agent.Info', agents[0]);
  // The single-agent route answers the same record.
  const single = (await json('/api/agent/build')).data;
  assert.equal(single.id, 'build');
  // An unknown agent is a refusal, not an empty record.
  assert.equal((await request('/api/agent/other')).status, 404);
});

test('the config entry names the default agent and model the client folds', async (t) => {
  // Why: the client reads `info.default_agent` and `info.model` from the config
  // list, lowest priority first, and takes the last definition. A missing key
  // leaves its composer with no default rather than reporting an error.
  const { json } = await fixtureServer(t);
  const entries = await json('/api/config');
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length > 0, true);
  const entry = entries.at(-1);
  contract('Config.Entry', entry);
  assert.equal(entry.info.default_agent, 'build');
  // The client's parseModelSelection accepts `{providerID, modelID ?? model}`,
  // which is the expanded form this surface emits.
  assert.equal(typeof entry.info.model.providerID, 'string');
  assert.equal(typeof entry.info.model.model, 'string');
  assert.equal(entry.info.model.model.length > 0, true);
});

test('api/info is the readiness signal the client holds every request on', async (t) => {
  // Why: the client's readiness gate polls `/api/info` and treats a 200 as "ready
  // to proxy"; while it is not ready, every request is held and then answered
  // 503. A shape change here does not degrade one route, it stops the whole
  // surface, so the exact contract is pinned rather than assumed.
  const { json } = await fixtureServer(t);
  const info = await json('/api/info');
  // The schema requires exactly these, and `paths.tmp` is the only path key.
  assert.deepEqual(Object.keys(info).sort(), ['paths', 'pid', 'urls', 'version']);
  assert.equal(typeof info.version, 'string');
  assert.equal(Number.isSafeInteger(info.pid) && info.pid > 0, true);
  assert.deepEqual(info.urls, []);
  assert.deepEqual(Object.keys(info.paths), ['tmp']);
  assert.equal(typeof info.paths.tmp, 'string');
  assert.equal(info.paths.tmp.length > 0, true);
  contract('ServerInfo', info);
  // A version the readiness gate would reject must never be reported.
  const major = Number(info.version.split('.')[0]);
  assert.equal(major, 2, 'the readiness gate refuses any major other than 2');
});

test('the reported version satisfies the OpenChamber compatibility gate', async (t) => {
  // Why: OpenChamber refuses a server whose major is not 2 or whose version is
  // below its own minimum. This test pins the rule rather than the literal, so a
  // future bump cannot silently make the whole surface unreachable.
  const parts = (value) => value.split(/[-+]/u, 1)[0].split('.').map(Number);
  const compare = (left, right) => { const a = parts(left); const b = parts(right);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]; return 0; };
  assert.equal(parts(WIRED_OPENCODE_VERSION)[0], 2, 'OpenChamber rejects a future major');
  assert.ok(compare(WIRED_OPENCODE_VERSION, MINIMUM_OPENCODE_VERSION) >= 0, 'the reported version must clear the client floor');
  const { json } = await fixtureServer(t);
  assert.equal((await json('/api/info')).version, WIRED_OPENCODE_VERSION);
});

test('v2 discovery, configured catalogs, and session CRUD conform to published schemas', async (t) => {
  const { json, request, root } = await fixtureServer(t);
  const info = await json('/api/info'); contract('ServerInfo', info); assert.equal(info.version, WIRED_OPENCODE_VERSION);
  contract('Location.PublicInfo', await json('/api/location'));
  for (const [path, name] of [['agent', 'Agent.Info'], ['model', 'Model.Info'], ['provider', 'Provider.Info']]) {
    const response = await json(`/api/${path}`); assert.deepEqual(response.location, { directory: root });
    contract(name, response.data[0]);
  }
  contract('Project', (await json('/api/project'))[0]);
  contract('Config.Entry', (await json('/api/config'))[0]);
  const session = (await json('/api/session', 'POST', { id: 'ses_client-id', title: 'First', metadata: { label: 'test' } })).data;
  contract('Session.Info', session); assert.equal(session.id, 'ses_client-id');
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Renamed' })).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.title, 'Renamed');
  assert.equal((await json(`/api/session?directory=${encodeURIComponent(root)}`)).data.length, 1);
  assert.equal((await json('/api/session?directory=elsewhere')).data.length, 0);
  assert.equal((await request(`/api/session/${session.id}`, 'DELETE')).status, 204);
  const missing = await request(`/api/session/${session.id}`);
  assert.equal(missing.status, 404); assert.equal((await missing.json())._tag, 'SessionNotFoundError');
});

test('v2 drops a slow event consumer instead of owning its socket forever', async () => {
  // Invariant: a consumer that stops reading must be closed and released, not
  // left attached to a stream it can no longer drain.
  const { createV2Events } = await import('../src/opencode/v2-events.js');
  const events = createV2Events();
  const destroyed = []; const listeners = {};
  const res = { destroyed: false, writableEnded: false, writes: 0,
    writeHead() {}, flushHeaders() {},
    write() { this.writes += 1; return this.writes === 1; },
    on(name, listener) { (listeners[name] ??= []).push(listener); },
    destroy() { this.destroyed = true; destroyed.push(this); },
    end() {} };
  try {
    assert.equal(events.subscribe(res), true);
    events.emit({ info: { location: { directory: '/tmp/project' }, id: 'ses_slow', sequence: 0 } }, 'session.created', { sessionID: 'ses_slow' });
    // The opener frame is written directly, so the first subscriber frame is
    // the one that reports backpressure and settles the slow consumer.
    assert.equal(res.destroyed, true);
    assert.equal(destroyed.length, 1);
  } finally { events.close(); }
});

test('v2 deletes release the session slot and its pending state', async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  assert.equal((await request(`/api/session/${session.id}`, 'DELETE')).status, 204);
  // Invariant: a removed session must not survive in any listing, snapshot or
  // capacity count, or a client that reconnects recreates a ghost.
  const listed = (await json('/api/session')).data;
  assert.equal(listed.some((item) => item.id === session.id), false);
  const active = await json('/api/session/active');
  assert.equal(Object.hasOwn(active.data, session.id), false);
  assert.equal((await json('/api/form')).data.length, 0);
  const again = await request(`/api/session/${session.id}`);
  assert.equal(again.status, 404);
  assert.equal((await again.json())._tag, 'SessionNotFoundError');
  // A second delete of an absent session stays a 404 rather than a silent success.
  assert.equal((await request(`/api/session/${session.id}`, 'DELETE')).status, 404);
});

test('a session update refuses permissions by name and still renames', async (t) => {
  // Security: permission rules belong to NNA's reviewer governance. The client
  // omits `permissions` unless a caller sets it, so refusing it must not block a
  // normal rename or archive.
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const denied = await request(`/api/session/${session.id}`, 'PATCH', { permissions: [] });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).message, /reviewer governance/u);
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Still fine' })).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.title, 'Still fine');
});

test('v2 archives and restores a session through the record patch', async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', { title: 'Archivable' })).data;
  const other = (await json('/api/session', 'POST', { title: 'Kept' })).data;
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: true })).status, 204);
  const archived = (await json(`/api/session/${session.id}`)).data;
  contract('Session.Info', archived);
  assert.equal(typeof archived.time.archived, 'number');
  // An archived session leaves the live list and is reachable only by its filter.
  const live = (await json('/api/session')).data.map((item) => item.id);
  assert.deepEqual(live, [other.id]);
  const archivedList = (await json('/api/session?archived=true')).data.map((item) => item.id);
  assert.deepEqual(archivedList, [session.id]);
  // Restoring clears the stamp rather than zeroing it.
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: null })).status, 204);
  const restored = (await json(`/api/session/${session.id}`)).data;
  assert.equal(Object.hasOwn(restored.time, 'archived'), false);
  assert.equal((await json('/api/session')).data.length, 2);
  // `archived: false` is the same restore, and junk is refused before any change.
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: true })).status, 204);
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: false })).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.time.archived, undefined);
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: 'yes' })).status, 400);
  assert.equal((await json(`/api/session/${session.id}`)).data.time.archived, undefined);
});

test('v2 restore announces the event a client translates to unarchive', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: true })).status, 204);
  await waitForEvent(events, 'session.patched');
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { archived: null })).status, 204);
  const restored = await waitForEvent(events, 'session.unarchived');
  await controller.abort();
  await collected;
  // Compatibility: the client's wire translator turns `session.unarchived` into
  // the restore its reducer applies; a restore expressed only as a patch has no
  // case there, so the session would stay hidden in the list.
  assert.deepEqual(restored.data, { sessionID: session.id });
});

test('v2 patch events carry only the changed fields', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Patched' })).status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { metadata: { label: 'note' } })).status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await controller.abort();
  await collected;
  const patches = events.filter((event) => event.type === 'session.patched').map((event) => event.data);
  // Invariant: the patch names the session and only the fields that changed, so
  // a client can apply it without reading the record back.
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], { sessionID: session.id, patch: { title: 'Patched' } });
  assert.deepEqual(patches[1], { sessionID: session.id, patch: { metadata: { label: 'note' } } });
});

test('v2 ends a failed turn with session.error carrying fixed guidance only', { timeout: 20_000 }, async (t) => {
  const { json, request, runtime } = await fixtureServer(t, { providerFactory: () => new FailingProvider() });
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'fail please' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await waitForEvent(events, 'session.error');
  await controller.abort();
  await collected;
  const failure = events.find((event) => event.type === 'session.error');
  assert.ok(failure, 'a failed turn must end with session.error');
  assert.equal(failure.data.sessionID, session.id);
  // A provider exception is not classified as a credential failure, so the code
  // stays the fixed generic one and its message is fixed guidance.
  assert.equal(failure.data.error.type, 'nna_execution_failed');
  assert.equal(failure.data.error.message, 'NNA could not complete the turn');
  // Security: provider exception text never becomes a public error message.
  assert.equal(JSON.stringify(events).includes('provider-secret-should-not-leak'), false);
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'failed');
});

test('v2 prompt admits client IDs, emits native events, and projects message history', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = [];
  const collected = (async () => {
    while (!controller.signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.some((event) => event.type === 'session.execution.succeeded')) { await reader.cancel(); break; }
    }
  })();
  const receipt = (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_from-client', text: 'hello', metadata: { source: 'test' } })).data;
  contract('Session.Inbox.User', receipt); assert.equal(receipt.id, 'msg_from-client');
  assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
  await collected;
  const messages = await json(`/api/session/${session.id}/message?order=asc`);
  // The settled turn is followed by the idle record a client walks back to.
  assert.equal(messages.data.length, 3);
  contract('Session.Message.User', messages.data[0]); contract('Session.Message.Assistant', messages.data[1]);
  assert.equal(messages.data[1].content[0].text, 'hello v2');
  assert.equal(messages.data[0].id, receipt.id);
  assert.deepEqual(messages.data[0].metadata, { source: 'test' });
  assert.equal(messages.data[2].type, 'idle');
  assert.equal(messages.data[2].outcome, 'succeeded');
  assert.equal(events[0].type, 'server.connected');
  assert.ok(events.some((event) => event.type === 'session.text.delta'));
  assert.ok(events.some((event) => event.type === 'session.text.ended' && event.data.text === 'hello v2'));
  const sequence = events.filter((event) => event.durable).map((event) => event.durable.seq);
  assert.equal(new Set(sequence).size, sequence.length); assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b));
  assert.ok(events.every((event) => !('payload' in event) && !('properties' in event)));
  assert.deepEqual((await json('/api/session/active')).data, {});
  contract('SessionInterruptResponse', await json(`/api/session/${session.id}/interrupt`, 'POST'));
});

test('v2 resolves the directory header the proxy forwards, and refuses a bad escape', async (t) => {
  const { json, request, root } = await fixtureServer(t);
  // The client percent-encodes the directory, and the proxy forwards it as sent.
  const header = encodeURIComponent(root);
  assert.equal((await json('/api/session?ignore=1', 'GET', undefined, { 'x-opencode-directory': header })).data.length, 0);
  const created = (await json('/api/session', 'POST', {}, { 'x-opencode-directory': header })).data;
  assert.equal(created.location.directory, root);
  // A query parameter wins over the header, as the client expects.
  const viaQuery = (await json(`/api/session?location[directory]=${encodeURIComponent(root)}`, 'GET', undefined,
    { 'x-opencode-directory': encodeURIComponent('/somewhere/else') })).data;
  assert.equal(viaQuery.some((session) => session.id === created.id), true);
  // Why: `session.list` scopes by the `directory` query parameter, not the
  // header, so a directory-scoped list is expressed in the query.
  const scoped = (await json(`/api/session?directory=${encodeURIComponent('/somewhere/else')}`)).data;
  assert.deepEqual(scoped, []);
  // Why: on a route that does read the header, a malformed escape is a refused
  // request, never a silent fallback to a different directory.
  const bad = await request('/api/session', 'POST', {}, { 'x-opencode-directory': '%E0%A4%A' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json())._tag, 'InvalidRequestError');
});

test('v2 history pagination stays stable across idle records', { timeout: 30_000 }, async (t) => {
  // Why: the idle record this surface appends after every turn changed the list
  // a cursor anchors on. A cursor must not skip or repeat a record, and the
  // page a client walks must reach the turn boundary it is looking for.
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  for (const text of ['one', 'two', 'three']) {
    await json(`/api/session/${session.id}/prompt`, 'POST', { text });
    await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  }
  const all = (await json(`/api/session/${session.id}/message?order=asc&limit=500`)).data;
  // user, assistant, idle for each of three turns.
  assert.equal(all.length, 9);
  assert.equal(all.filter((message) => message.type === 'idle').length, 3);
  const firstPage = await json(`/api/session/${session.id}/message?order=asc&limit=4`);
  assert.equal(firstPage.data.length, 4);
  assert.equal(firstPage.cursor.next === null, false);
  // Why no `order` here: the cursor carries the order it was issued under, and a
  // request that repeats it is refused rather than silently reinterpreted.
  const secondPage = (await json(`/api/session/${session.id}/message?limit=4&cursor=${encodeURIComponent(firstPage.cursor.next)}`)).data;
  assert.equal((await request(`/api/session/${session.id}/message?order=asc&cursor=${encodeURIComponent(firstPage.cursor.next)}`)).status, 400);
  const walked = [...firstPage.data, ...secondPage];
  // Invariant: walking the pages visits every record exactly once, in order.
  assert.deepEqual(walked.map((message) => message.id), all.slice(0, walked.length).map((message) => message.id));
  assert.equal(new Set(walked.map((message) => message.id)).size, walked.length);
});

test('v2 delivers the answer when the provider sends it in one chunk', { timeout: 20_000 }, async (t) => {
  // Why: the client builds assistant text from `session.text.delta` and has no
  // case for `session.text.started`/`session.text.ended`. A provider that
  // answers in a single chunk used to emit only the latter pair, so the answer
  // was invisible in the GUI even though the turn succeeded.
  class SingleChunk {
    async *stream(request) {
      if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
        yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
        yield { type: 'terminal', finishReason: 'tool_calls' }; return;
      }
      yield { type: 'text', text: 'one chunk answer' };
      yield { type: 'terminal', finishReason: 'stop' };
    }
  }
  const { json, request, runtime } = await fixtureServer(t, { providerFactory: () => new SingleChunk() });
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'answer once' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await waitForEvent(events, 'session.text.delta');
  await controller.abort();
  await collected;
  const text = events.filter((event) => event.type === 'session.text.delta').map((event) => event.data.delta).join('');
  assert.equal(text, 'one chunk answer');
});

test('a tool part survives the text part that follows it', () => {
  // Why: a text part is rewritten as it streams, and a wholesale content
  // assignment erased every tool call the moment the answer landed. A turn that
  // read a file then showed the answer with no tool row, which is what a live
  // tool-using turn exposed.
  const emitted = [];
  const state = { info: { id: 'ses_a', model: { id: 'm', providerID: 'p' } }, messages: new Map(),
    inputs: new Map(), inbox: new Map(), cancelled: new Set(), forms: new Map() };
  const events = { emit: (_s, type, data) => emitted.push({ type, data }) };
  observeV1Event(state, { type: 'message.updated', properties: {
    info: { id: 'msg_a', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } } } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: {
    type: 'tool', id: 'prt_t', messageID: 'msg_a', name: 'fs_read',
    state: { status: 'running', input: {}, metadata: {} }, time: { created: 2 } } } }, events);
  // The answer arrives after the tool call.
  observeV1Event(state, { type: 'message.part.updated', properties: { part: {
    type: 'text', id: 'prt_x', messageID: 'msg_a', text: 'the answer',
    time: { start: 3, end: 4 } } } }, events);
  const content = state.messages.get('msg_a').content;
  assert.deepEqual(content.map((item) => item.type), ['tool', 'text']);
  assert.equal(content[0].name, 'fs_read');
  assert.equal(content[1].text, 'the answer');
  // Security: the tool part carries the name and lifecycle state. The wire sends
  // an empty input placeholder, and no arguments or result content ride along.
  assert.deepEqual(content[0].state.input ?? {}, {});
  assert.equal('content' in content[0].state, false);
  assert.equal('error' in content[0].state, false);
});

test('a tool part updates in place rather than appending a row per record', () => {
  const emitted = [];
  const state = { info: { id: 'ses_a', model: { id: 'm', providerID: 'p' } }, messages: new Map(),
    inputs: new Map(), inbox: new Map(), cancelled: new Set(), forms: new Map() };
  const events = { emit: () => undefined };
  observeV1Event(state, { type: 'message.updated', properties: {
    info: { id: 'msg_b', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } } } }, events);
  for (const status of ['running', 'running', 'completed']) {
    observeV1Event(state, { type: 'message.part.updated', properties: { part: {
      type: 'tool', id: 'prt_same', messageID: 'msg_b', name: 'fs_read',
      state: { status }, time: { created: 2 } } } }, events);
  }
  assert.equal(state.messages.get('msg_b').content.length, 1);
  assert.equal(state.messages.get('msg_b').content[0].state.status, 'completed');
  void emitted;
});

test('the tool lifecycle reaches the v2 stream verbatim, the way a live client reads it', () => {
  // Why: the wire session publishes session.tool.* on the engine bus, and the v2
  // projection is the only path from that bus to /api/event. It dispatches no
  // case for these types, so without forwarding a tool-using turn shows no tool
  // row while it runs — the client renders live tools only from this vocabulary.
  const emitted = [];
  const state = { info: { id: 'ses_a' } };
  const events = { emit: (_s, type, data, durable = true, version = 1) => emitted.push({ type, data, durable, version }) };
  const base = { sessionID: 'ses_a', assistantMessageID: 'msg_a', id: 'prt_t' };
  observeV1Event(state, { type: 'session.tool.input.started', properties: { ...base, name: 'fs_read' } }, events);
  observeV1Event(state, { type: 'session.tool.called', properties: { ...base, input: {}, executed: true } }, events);
  observeV1Event(state, { type: 'session.tool.success', properties: {
    ...base, content: [{ type: 'text', text: '' }], executed: true } }, events);
  observeV1Event(state, { type: 'session.tool.failed', properties: {
    ...base, error: { type: 'nna_tool_failed', message: 'x' }, executed: true } }, events);
  assert.deepEqual(emitted.map((event) => event.type), [
    'session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed',
  ]);
  // Invariant: forwarded unchanged — the id that joins the row and the cell that
  // closes it survive the trip to the stream.
  assert.equal(emitted[0].data.name, 'fs_read');
  assert.equal(emitted[1].data.executed, true);
  assert.deepEqual(emitted[2].data.content, [{ type: 'text', text: '' }]);
  for (const event of emitted) assert.equal(event.durable, true);
  // Compatibility: the client declares the terminal pair at durable version 2 and
  // the opening pair at the shared 1; a mismatch fails a strict envelope decode.
  assert.deepEqual(emitted.map((event) => event.version), [1, 1, 2, 2]);
});

test('a timeline mutation the session cannot accept is a conflict, not a failure', { timeout: 30_000 }, async (t) => {
  // Why: the engine's timeline guards raise plain contract codes with no HTTP
  // status, so a busy session reached the client as an opaque 500 "NNA could not
  // complete the request". A refused mutation is a conflict the caller can act on.
  // Forking a session that has not completed a turn was the worst case: a brand
  // new session is a legitimate idle state, and the answer was still a 500.
  const { json, request } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const fresh = (await json('/api/session', 'POST', { title: 'Fresh' })).data;

  const noTurn = await request(`/api/session/${fresh.id}/fork`, 'POST', {});
  assert.equal(noTurn.status, 409);
  const noTurnBody = await noTurn.json();
  assert.equal(noTurnBody._tag, 'ConflictError');
  assert.match(noTurnBody.message, /at least one turn/u);

  // A boundary this session never admitted names the message.
  await json(`/api/session/${fresh.id}/prompt`, 'POST', { id: 'msg_cf01', text: 'hello' });
  await request(`/api/experimental/session/${fresh.id}/wait`, 'POST');
  const unknownBoundary = await request(`/api/session/${fresh.id}/fork`, 'POST', { before: 'msg_absent' });
  assert.equal(unknownBoundary.status, 404);
  assert.equal((await unknownBoundary.json())._tag, 'MessageNotFoundError');

  // With a settled turn and no boundary, the fork succeeds.
  assert.equal((await request(`/api/session/${fresh.id}/fork`, 'POST', {})).status, 200);

  // Clearing a revert that was never staged is a conflict, not a failure.
  const noRevert = await request(`/api/session/${fresh.id}/revert`, 'DELETE');
  assert.equal(noRevert.status, 409);
  assert.equal((await noRevert.json())._tag, 'ConflictError');
});

test('the form routes answer an empty list when nothing is pending', { timeout: 20_000 }, async (t) => {
  // Why: sessions are created with `auto-review`, so a client driven from
  // OpenChamber never sees a pending form. These routes had no test because the
  // obvious path never reaches them; an empty list must be a valid answer rather
  // than an error, or a client that polls for forms would show a failure.
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', { title: 'Forms' })).data;
  const list = await json(`/api/session/${session.id}/form`);
  assert.deepEqual(list.data, []);
  // Reading, settling or dismissing a form that is not pending names what is
  // missing instead of failing as an internal error.
  for (const [method, path, body] of [
    ['GET', `/api/session/${session.id}/form/frm_absent`, undefined],
    ['POST', `/api/session/${session.id}/form/frm_absent`, { decision: 'approve' }],
    ['DELETE', `/api/session/${session.id}/form/frm_absent`, undefined],
  ]) {
    const response = await request(path, method, body);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal((await request('/api/session/ses_absent/form')).status, 404);
});

test('prompts arriving together all admit instead of blaming a model selection', { timeout: 40_000 }, async (t) => {
  // Why: every prompt re-binds the provider selection first, and that briefly
  // marks the session as selecting. Two clients arriving in the same tick — two
  // tabs, or the desktop and a phone — made the loser answer 409 "Wait for the
  // session to become idle before changing its model", a selection it never asked
  // for. Prompts queue rather than reject, so concurrent admissions take turns.
  const { json, request } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const session = (await json('/api/session', 'POST', { title: 'Together' })).data;
  // Fired in the same tick, with no awaits between them.
  const admitted = await Promise.all([
    request(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_tog1', text: 'one' }),
    request(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_tog2', text: 'two' }),
    request(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_tog3', text: 'three' }),
  ]);
  assert.deepEqual(admitted.map((response) => response.status), [200, 200, 200],
    'no concurrent prompt is refused for a selection it did not request');
  assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
  const messages = (await json(`/api/session/${session.id}/message?order=asc&limit=500`)).data;
  const users = messages.filter((message) => message.type === 'user');
  // Invariant: every admitted prompt is present exactly once, and answered.
  assert.deepEqual(users.map((message) => message.id).sort(), ['msg_tog1', 'msg_tog2', 'msg_tog3']);
  assert.equal(messages.filter((message) => message.type === 'assistant').length, 3);
  assert.equal(messages.filter((message) => message.type === 'idle').length, 3);
});

test('v2 forks a session and the child inherits its settled turn', { timeout: 30_000 }, async (t) => {
  // Why: a fork replays the parent prefix into the child engine silently, so no
  // events describe the inherited turns. The child's message list was therefore
  // empty and a fork looked like a blank session, even though its engine held the
  // transcript. The descriptive context fields matter too: without a title the
  // child was named "undefined-fork".
  const { json, request } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const parent = (await json('/api/session', 'POST', { title: 'Parent' })).data;
  await json(`/api/session/${parent.id}/prompt`, 'POST', { id: 'msg_fork01', text: 'hello' });
  await request(`/api/experimental/session/${parent.id}/wait`, 'POST');

  const forked = await request(`/api/session/${parent.id}/fork`, 'POST', {});
  assert.equal(forked.status, 200);
  const child = (await forked.json()).data;
  assert.match(child.id, /^ses_/u);
  assert.equal(child.parentID, parent.id);
  assert.equal(child.slug, 'parent-fork');
  assert.notEqual(child.id, parent.id);

  const childHistory = (await json(`/api/session/${child.id}/message?order=asc`)).data;
  // The inherited turn arrives as a user prompt and its assistant reply.
  assert.deepEqual(childHistory.map((message) => message.type), ['user', 'assistant']);
  assert.equal(childHistory[1].content[0].text, 'hello v2');
  // The parent keeps its own idle marker and is not disturbed.
  assert.deepEqual((await json(`/api/session/${parent.id}/message?order=asc`)).data.map((message) => message.type),
    ['user', 'assistant', 'idle']);
  // The child is listed under its parent, which the client uses for the tree.
  const listed = (await json('/api/session')).data;
  assert.equal(listed.length, 2);
  assert.equal(listed.filter((session) => session.parentID === parent.id).length, 1);
  // An unknown boundary is a missing message, not a surface failure.
  assert.equal((await request(`/api/session/${parent.id}/fork`, 'POST', { before: 'msg_absent' })).status, 404);
});

test('v2 reads one message by id and refuses an unknown one', { timeout: 20_000 }, async (t) => {
  // Why: a tool completion reads a single message to finish a call, and this
  // route had no direct test — it is the one a live turn relied on.
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_read01', text: 'hello' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');

  const user = (await json(`/api/session/${session.id}/message/msg_read01`)).data;
  // The pinned schema requires exactly id, time, text and type; a `parts` array
  // here would violate its additionalProperties rule.
  assert.deepEqual(Object.keys(user).sort(), ['id', 'text', 'time', 'type']);
  assert.equal(user.type, 'user');
  assert.equal(user.text, 'hello');
  assert.equal(user.time.created > 0, true);
  contract('Session.Message.User', user);

  const missing = await request(`/api/session/${session.id}/message/msg_absent`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json())._tag, 'MessageNotFoundError');
  // A message id belonging to no session in this surface is still a refusal.
  assert.equal((await request('/api/session/ses_missing/message/msg_read01')).status, 404);
});

test('v2 history closes each settled turn with an idle record', { timeout: 20_000 }, async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  for (const [index, text] of ['first', 'second'].entries()) {
    await json(`/api/session/${session.id}/prompt`, 'POST', { text });
    assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
    const messages = (await json(`/api/session/${session.id}/message?order=asc`)).data;
    // Invariant: a v2 client finds the running turn by walking history back to
    // an idle record. Each settled turn adds exactly one, so a turn's duration
    // is measurable and a restart cannot mistake an old turn for a live one.
    const idles = messages.filter((message) => message.type === 'idle');
    assert.equal(idles.length, index + 1);
    assert.equal(idles.at(-1).outcome, 'succeeded');
    assert.match(idles.at(-1).id, /^msg_/u);
    assert.equal(typeof idles.at(-1).time.created, 'number');
    assert.equal(messages.at(-1).type, 'idle');
  }
});

test('v2 records a model switch as history a client can read back', { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-v2-model-'));
  const settingsPath = join(root, 'config', 'opencode.json');
  await (await import('node:fs/promises')).mkdir(join(root, 'config'));
  const { OpenCodeProviderSettings } = await import('../src/opencode/provider-settings.js');
  const settings = new OpenCodeProviderSettings({ root: join(root, 'runtime'), configPaths: [settingsPath], environment: {} });
  const { json, request } = await fixtureServer(t, { providerSettings: settings });
  await settings.upsert({ providerID: 'test', scope: 'user', config: { name: 'Test',
    package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://127.0.0.1:9999/v1' },
    models: { alpha: { name: 'Alpha' }, beta: { name: 'Beta' } } } });
  const session = (await json('/api/session', 'POST', { model: { id: 'alpha', providerID: 'test' } })).data;
  assert.equal((await request(`/api/session/${session.id}/model`, 'POST', { model: { id: 'beta', providerID: 'test' } })).status, 204);
  const messages = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  const switched = messages.filter((message) => message.type === 'model-switched');
  // Compatibility: OpenCode 2 records a model switch in history; a client that
  // walks history expects the switch rather than a silent gap.
  assert.equal(switched.length, 1);
  assert.deepEqual(switched[0].model, { id: 'beta', providerID: 'test' });
  assert.deepEqual(switched[0].previous, { id: 'alpha', providerID: 'test' });
  assert.equal(typeof switched[0].time.created, 'number');
  assert.match(switched[0].id, /^msg_/u);
  // Filtering by type still works over the combined history.
  const onlySwitches = (await json(`/api/session/${session.id}/message?type=model-switched`)).data;
  assert.equal(onlySwitches.length, 1);
});

test('v2 synthetic admission continues a turn behind the same guards as a prompt', { timeout: 20_000 }, async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const receipt = (await json(`/api/session/${session.id}/synthetic`, 'POST', {
    id: 'msg_synthetic', text: 'resume the interrupted turn', description: 'opencode-restart',
  })).data;
  // Compatibility: a continuation is admitted like a prompt and tagged as
  // synthetic so a transcript can tell it from operator speech.
  assert.equal(receipt.id, 'msg_synthetic');
  assert.equal(receipt.type, 'synthetic');
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const messages = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  assert.equal(messages[0].id, 'msg_synthetic');
  // The same input rules apply, so a synthetic continuation cannot smuggle in
  // an unsupported field or a reserved identifier.
  assert.equal((await request(`/api/session/${session.id}/synthetic`, 'POST', { text: 'x', permissions: [] })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/synthetic`, 'POST', null)).status, 400);
  assert.equal((await request('/api/session/ses_missing/synthetic', 'POST', { text: 'x' })).status, 404);
});

/** Open the live event stream and collect frames until `stopOn` appears. */
async function collectEvents(t, runtime, stopOn, admit) {
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = [];
  const collected = (async () => {
    while (!controller.signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.some((event) => event.type === stopOn)) { await reader.cancel(); break; }
    }
  })();
  await admit();
  await collected;
  return events;
}

test('v2 holds a resume:false synthetic as a durable row that opens no turn', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  // The goal-mode order the published client sends: prompt first, briefing
  // after ("the user message above"), and the briefing must not start a turn.
  (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_task', text: 'the task' })).data;
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const held = (await json(`/api/session/${session.id}/synthetic`, 'POST', {
    id: 'msg_brief', text: 'goal briefing', description: 'goal', metadata: { source: 'goal' }, resume: false,
  })).data;
  contract('Session.Inbox.Synthetic', held);
  assert.equal(held.id, 'msg_brief'); assert.equal(held.type, 'synthetic');
  assert.equal(held.payload.description, 'goal');
  const state = runtime.workspace.v2.states.get(session.id);
  // Invariant: holding a briefing schedules nothing — no second run on a
  // session the wait already settled, and no queued work behind it.
  assert.equal(state.running, false);
  assert.equal(state.pending.size, 0);
  assert.deepEqual([...state.inbox.keys()], [], 'a held briefing never enters the inbox the composer reconciles from');
  const rows = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  const synthetics = rows.filter((row) => row.type === 'synthetic');
  assert.equal(synthetics.length, 1);
  contract('Session.Message.Synthetic', synthetics[0]);
  // Compatibility: the client-minted `id` in the request body is not the row
  // id. The published reducer names the row from the v2 event id
  // (`evt_` → `msg_`), and the next test pins that binding; a row keyed to the
  // caller's id would never match what the live stream inserted.
  assert.match(synthetics[0].id, /^msg_[0-9a-f-]{36}$/u);
  assert.equal(synthetics[0].text, 'goal briefing');
  assert.equal(synthetics[0].description, 'goal');
  assert.equal('metadata' in synthetics[0], false, 'the strict client schema has no metadata field');
  // And exactly once on a fresh read: the row is stored, not re-derived.
  const again = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  assert.equal(again.filter((row) => row.type === 'synthetic').length, 1);
  assert.equal(again.filter((row) => row.type === 'assistant').length, 1, 'the briefing opened no assistant turn');
});

test('v2 announces a held synthetic as durable version one on the event stream', async (t) => {
  const { json, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const events = await collectEvents(t, runtime, 'session.synthetic', async () => {
    (await json(`/api/session/${session.id}/synthetic`, 'POST', { text: 'goal briefing', description: 'goal', metadata: { openchamber: { goal: true } }, resume: false })).data;
  });
  const synthetic = events.filter((event) => event.type === 'session.synthetic');
  assert.equal(synthetic.length, 1);
  assert.equal(synthetic[0].durable.version, 1, 'the client declares version 1 for this type');
  assert.equal(typeof synthetic[0].durable.seq, 'number', 'a reconnect replays the row from the durable stream');
  assert.equal(synthetic[0].data.sessionID, session.id);
  assert.equal(synthetic[0].data.text, 'goal briefing');
  assert.equal(synthetic[0].data.description, 'goal');
  assert.deepEqual(synthetic[0].data.metadata, { openchamber: { goal: true } });
  // Compatibility: the client's reducer names the row from the v2 event id
  // (`evt_` → `msg_`), so the stored row must carry that same id or a reload
  // shows the briefing twice.
  const row = (await json(`/api/session/${session.id}/message?order=asc`)).data
    .find((message) => message.type === 'synthetic');
  assert.equal(row.id, `msg_${String(synthetic[0].id).slice(4)}`);
});

test('v2 delivers a held briefing to the model as untrusted system context', async (t) => {
  const seen = [];
  class RecordingProvider extends Provider {
    async *stream(request) { seen.push(request.messages.map((message) => ({ role: message.role, content: message.content }))); return super.stream(request); }
  }
  const { json, request } = await fixtureServer(t, { providerFactory: () => new RecordingProvider() });
  const session = (await json('/api/session', 'POST', {})).data;
  (await json(`/api/session/${session.id}/synthetic`, 'POST', { text: 'BRIEFING TEXT', resume: false })).data;
  (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_task', text: 'the task' })).data;
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  assert.ok(seen.length >= 1);
  const final = seen.at(-1);
  // Security: the briefing reaches the model, and never through the operator
  // lane — no user-role message may carry it (AGENTS.md: nothing the wire
  // carries may grant authority).
  assert.equal(final.some((message) => message.role === 'user' && String(message.content).includes('BRIEFING TEXT')), false);
  assert.equal(final.some((message) => String(message.content).includes('BRIEFING TEXT')), true, 'the briefing must reach the model at all');
  assert.ok(final.some((message) => message.role === 'system' && String(message.content).includes('BRIEFING TEXT')));
  assert.ok(final.some((message) => message.role === 'user' && String(message.content).includes('the task')));
  // The briefing survives a revert of the turn that consumed it: it is context,
  // not part of that turn, so history keeps showing it.
  const rows = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  assert.equal(rows.filter((row) => row.type === 'synthetic').length, 1);
});

test('v2 answers a full held queue as a retryable capacity refusal', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  for (let index = 0; index < 16; index += 1) {
    const held = await json(`/api/session/${session.id}/synthetic`, 'POST', { text: `briefing-${index}`, resume: false });
    assert.equal(held.data.type, 'synthetic');
  }
  const refused = await request(`/api/session/${session.id}/synthetic`, 'POST', { text: 'one too many', resume: false });
  // Why 429 and not 400: the caller's text is fine, the session is full of it.
  // A 400 tells the client to discard a briefing it should retry.
  assert.equal(refused.status, 429);
  // The queue recovers once its briefings are delivered by the next real turn.
  (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_task', text: 'the task' })).data;
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const later = await request(`/api/session/${session.id}/synthetic`, 'POST', { text: 'after delivery', resume: false });
  assert.equal(later.status, 200);
  assert.equal(runtime.workspace.registry.get(session.id).wireSession.pendingCount(), 0);
});

test('v2 accepts resume on a prompt, refuses defer on one, and refuses a non-boolean resume', async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  // The client sends `resume` on prompts too in goal-adjacent paths; accepting
  // the boolean keeps a strict-forwarding proxy from failing the admission.
  (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_bool', text: 'a', resume: true })).data;
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  // Why a prompt cannot defer: its text is an operator task, and this surface
  // has no deferred lane for it. Every real `resume: false` caller in the
  // client posts to `/synthetic`; silently holding a task would deliver
  // operator speech later as untrusted briefing context and never run it.
  const refuseDefer = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'b', resume: false });
  assert.equal(refuseDefer.status, 400); assert.equal((await refuseDefer.json())._tag, 'InvalidRequestError');
  for (const resume of ['false', 0, 1, 'true']) {
    const denied = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'b', resume });
    assert.equal(denied.status, 400); assert.equal((await denied.json())._tag, 'InvalidRequestError');
    const synth = await request(`/api/session/${session.id}/synthetic`, 'POST', { text: 'b', resume });
    assert.equal(synth.status, 400);
  }
});

test('v2 interrupt leaves held briefings for the next turn', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  (await json(`/api/session/${session.id}/synthetic`, 'POST', { text: 'undelivered briefing', resume: false })).data;
  const queued = request(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_q', text: 'queued prompt' });
  await new Promise((resolve) => setImmediate(resolve));
  // The first prompt runs; the second waits behind it, so stopping drains the
  // queue. The briefing belongs to no drained turn.
  const interrupt = (await json(`/api/session/${session.id}/interrupt`, 'POST'));
  contract('SessionInterruptResponse', interrupt);
  await queued.catch(() => {});
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  const state = runtime.workspace.v2.states.get(session.id);
  assert.deepEqual([...state.inbox.keys()], [], 'interrupt clears only the inbox lane');
  const rows = (await json(`/api/session/${session.id}/message?order=asc`)).data;
  assert.equal(rows.filter((row) => row.type === 'synthetic').length, 1, 'the briefing is not cancelled with the queue');
});

test('v2 rejects malformed and unsupported requests before engine submission', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  for (const input of [null, [], { text: 'x', files: [{}] }, { text: 'x', permissions: [] }, { text: 'x', resume: 'false' }, { text: 'x', resume: 0 }, { text: 'x', model: { id: 'other' } }]) {
    const denied = await request(`/api/session/${session.id}/prompt`, 'POST', input);
    assert.equal(denied.status, 400); assert.equal((await denied.json())._tag, 'InvalidRequestError');
  }
  assert.equal(runtime.workspace.registry.get(session.id).wireSession.messages().length, 0);
  assert.equal((await request('/api/session', 'POST', { permissions: [] })).status, 400);
  assert.equal((await request('/api/session?cursor=garbage')).status, 400);
  assert.equal((await request('/api/session?limit=-2')).status, 400);
  assert.equal((await request(`/api/session/${session.id}/permission`, 'POST', { action: 'allow' })).status, 404);
});

test('v2 auth covers discovery, event streaming, and mutations', async (t) => {
  const { request } = await fixtureServer(t, { password: 'fixture-password' });
  for (const [path, method] of [['/api/info', 'GET'], ['/api/event', 'GET'], ['/api/session', 'POST']]) {
    const denied = await request(path, method, method === 'POST' ? {} : undefined);
    assert.equal(denied.status, 401); assert.equal((await denied.json())._tag, 'UnauthorizedError');
  }
  const response = await request('/api/info', 'GET', undefined, { authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}` });
  assert.equal(response.status, 200);
});

test('v2 session pagination keeps filters and supports both directions', async (t) => {
  const { json } = await fixtureServer(t);
  for (let index = 0; index < 3; index += 1) await json('/api/session', 'POST', { title: `page-${index}` });
  const first = await json('/api/session?limit=2&order=asc');
  const next = await json(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(next.data.length, 1); assert.equal(new Set([...first.data, ...next.data].map((item) => item.id)).size, 3);
  const previous = await json(`/api/session?limit=2&cursor=${next.cursor.previous}`);
  assert.deepEqual(previous.data, first.data);
});

test('v2 pagination stays anchored when sessions are inserted and requires recovery after anchor deletion', async (t) => {
  const { json, request } = await fixtureServer(t);
  for (let index = 0; index < 3; index += 1) await json('/api/session', 'POST', { title: `page-${index}` });
  const first = await json('/api/session?limit=2&order=desc');
  await json('/api/session', 'POST', { title: 'newest' });
  const next = await json(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(next.data.length, 1);
  assert.equal(new Set([...first.data, ...next.data].map((item) => item.id)).size, 3);
  assert.equal((await request(`/api/session/${first.data.at(-1).id}`, 'DELETE')).status, 204);
  const invalid = await request(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(invalid.status, 400); assert.equal((await invalid.json())._tag, 'InvalidCursorError');
});

test('v2 rejected selections, invalid directories, and partial updates do not change session state', async (t) => {
  const { json, request, runtime, root } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', { id: 'ses_client', title: 'Original' })).data;
  assert.equal(runtime.workspace.registry.get(session.id).engine.config.workspaceRoot, root);
  assert.equal((await request('/api/session', 'POST', { id: session.id })).status, 409);
  assert.equal((await request('/api/session', 'POST', { location: { directory: join(root, 'missing') } })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/model`, 'POST', { model: { id: 'other', providerID: 'test' } })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/agent`, 'POST', { agent: 'plan' })).status, 400);
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Changed', metadata: 12 })).status, 400);
  assert.equal((await json(`/api/session/${session.id}`)).data.title, 'Original');
  assert.equal((await request('/api/location', 'GET', undefined, { 'x-opencode-directory': '%invalid' })).status, 400);
});

class QuestionProvider extends Provider {
  calls = 0;
  async *stream(request) {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'question', function: {
        name: 'question', arguments: JSON.stringify({ questions: [{ question: 'Choose channel', options: [{ label: 'stable' }, { label: 'beta' }] }] }),
      } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield* super.stream(request);
  }
}

async function waitForEvent(events, type) {
  for (let index = 0; index < 200; index += 1) {
    if (events.some((event) => event.type === type)) return events.find((event) => event.type === type);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${type} did not arrive`);
}

async function waitForForm(json, sessionID) {
  for (let index = 0; index < 200; index += 1) {
    const forms = (await json(`/api/session/${sessionID}/form`)).data;
    if (forms.length) return forms[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Question did not become a form');
}

test('v2 settlement emits the form.settled disposition clients clear from', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json, request, runtime } = await fixtureServer(t, { providerFactory: () => provider });
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  const collected = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* the reader is cancelled when the test ends */ }
  })();
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'ask me' });
  const form = await waitForForm(json, session.id);
  assert.equal((await request(`/api/session/${session.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 204);
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  await controller.abort();
  await collected;
  const settled = events.filter((event) => event.type === 'form.settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].data.sessionID, session.id);
  assert.equal(settled[0].data.formID, form.id);
  assert.equal(settled[0].data.disposition, 'replied');
  // The answer-bearing event stays available for clients that read it instead.
  assert.ok(events.some((event) => event.type === 'form.replied'));
});

test('v2 forms recover pending questions and enforce ownership, choices, and single settlement', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json, request } = await fixtureServer(t, { providerFactory: () => provider });
  const first = (await json('/api/session', 'POST', {})).data;
  const other = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${first.id}/prompt`, 'POST', { text: 'ask me' });
  const form = await waitForForm(json, first.id); contract('Form.Info', form);
  assert.equal((await json('/api/form')).data[0].id, form.id);
  contract('Form.Detail', (await json(`/api/session/${first.id}/form/${form.id}`)).data);
  assert.equal((await request(`/api/session/${other.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 404);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'invalid' } })).status, 400);
  assert.equal((await json(`/api/session/${first.id}/form`)).data.length, 1);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 204);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 409);
  assert.equal((await request(`/api/experimental/session/${first.id}/wait`, 'POST')).status, 204);
  assert.deepEqual((await json(`/api/session/${first.id}/form`)).data, []);
  assert.equal((await json(`/api/session/${first.id}`)).data.outcome, 'succeeded');
});

test('v2 interrupt reports the work it stopped while the busy frame is still in flight', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json } = await fixtureServer(t, { providerFactory: () => provider });
  const session = (await json('/api/session', 'POST', {})).data;
  // Admission returns before the projected `session.status busy` frame, so an
  // operator stop in that window must still report the turn it stopped.
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'ask me' });
  assert.deepEqual(await json(`/api/session/${session.id}/interrupt`, 'POST'), { interrupted: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  // An idle session with nothing admitted reports a truthful no-op.
  assert.deepEqual(await json(`/api/session/${session.id}/interrupt`, 'POST'), { interrupted: false });
});

test('v2 interruption cancels the active question and prevents queued execution', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json, request } = await fixtureServer(t, { providerFactory: () => provider });
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'ask me' });
  const form = await waitForForm(json, session.id);
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'queued', id: 'msg_queued', delivery: 'queue' });
  assert.equal((await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'steer', delivery: 'steer' })).status, 409);
  assert.equal((await json('/api/session/active')).data[session.id].type, 'running');
  assert.deepEqual(await json(`/api/session/${session.id}/interrupt`, 'POST'), { interrupted: true });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  assert.equal(provider.calls, 1);
  assert.deepEqual((await json(`/api/session/${session.id}/inbox`)).data, []);
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'interrupted');
  assert.equal((await json(`/api/session/${session.id}/form/${form.id}`)).data.state.status, 'cancelled');
  assert.ok((await json(`/api/session/${session.id}/message`)).data.every((message) => message.id !== 'msg_queued'));
});

test('published OpenCode client completes the v2 chat lifecycle', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE, timeout: 20_000 }, async (t) => {
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const { runtime, root } = await fixtureServer(t);
  const client = OpenCode.make({ baseUrl: runtime.url, headers: { 'x-opencode-directory': encodeURIComponent(root) } });
  assert.equal((await client.server.info()).version, WIRED_OPENCODE_VERSION);
  assert.equal((await client.location.get()).directory, root);
  assert.equal((await client.model.list()).data.length, 1);
  assert.deepEqual((await client.permission.request.list()).data, []);
  const events = client.event.subscribe({ signal: AbortSignal.timeout(15_000) })[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, 'server.connected');
  const collect = (async () => {
    const result = [];
    for (let count = 0; count < 100; count += 1) {
      const item = await events.next(); if (item.done) break;
      result.push(item.value);
      if (item.value.type === 'session.execution.succeeded') break;
    }
    await events.return(); return result;
  })();
  const session = await client.session.create({ title: 'Official client' });
  assert.equal(session.location.directory, root);
  const admitted = await client.session.prompt({ sessionID: session.id, id: 'msg_sdk', text: 'hello' });
  assert.equal(admitted.id, 'msg_sdk');
  await client.session.wait({ sessionID: session.id });
  const stream = await collect;
  assert.ok(stream.some((event) => event.type === 'session.text.ended' && event.data.text === 'hello v2'));
  assert.equal((await client.message.list({ sessionID: session.id, order: 'asc' })).data[1].content[0].text, 'hello v2');
  await client.session.remove({ sessionID: session.id });
  assert.deepEqual((await client.session.list()).data, []);
});

test('the published client reads and writes every record this surface exposes', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE, timeout: 30_000 }, async (t) => {
  // Why through the client: its response schemas are the real contract. Two
  // defects already survived hand-written tests — a revert answer missing
  // `messageID`, and an event envelope shape — so each surface is exercised the
  // way OpenChamber exercises it rather than the way this suite imagined.
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const { runtime, root } = await fixtureServer(t);
  const client = OpenCode.make({ baseUrl: runtime.url, headers: { 'x-opencode-directory': encodeURIComponent(root) } });

  // Catalogs the composer reads.
  assert.equal((await client.agent.list()).data[0].id, 'build');
  assert.equal((await client.config.get())[0].info.default_agent, 'build');
  assert.equal((await client.project.list())[0].canonical, root);

  const session = await client.session.create({ title: 'Records', metadata: { label: 'first' } });
  assert.equal(session.title, 'Records');

  // A rename and a metadata write both land as a patch the client applies.
  await client.session.update({ sessionID: session.id, title: 'Renamed' });
  assert.equal((await client.session.get({ sessionID: session.id })).title, 'Renamed');
  await client.session.update({ sessionID: session.id, metadata: { label: 'second' } });
  assert.deepEqual((await client.session.get({ sessionID: session.id })).metadata, { label: 'second' });

  // Archive leaves the live list; restore brings it back. The client sends
  // `archived`, not the `time.archived` patch a stored record carries.
  await client.session.update({ sessionID: session.id, archived: true });
  assert.equal((await client.session.list()).data.some((item) => item.id === session.id), false);
  await client.session.update({ sessionID: session.id, archived: null });
  assert.equal((await client.session.list()).data.some((item) => item.id === session.id), true);

  // Unread state and the active snapshot both answer in the client's shapes.
  // `session.active` unwraps to `value.data`, which is the map itself.
  await client.session.view({ sessionID: session.id, idle: 0 });
  assert.deepEqual(Object.keys(await client.session.active()), []);
  await client.session.remove({ sessionID: session.id });
});

test('the published client reads a message, interrupts, and settles a form', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE, timeout: 30_000 }, async (t) => {
  // Why through the client: `message.get` and the form routes have the most call
  // sites in OpenChamber, and their response shapes are asserted by the client's
  // own schemas. Hand-written requests have already missed two such mismatches.
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const provider = new QuestionProvider();
  const { runtime, root } = await fixtureServer(t, { providerFactory: () => provider });
  const client = OpenCode.make({ baseUrl: runtime.url, headers: { 'x-opencode-directory': encodeURIComponent(root) } });
  const session = await client.session.create({ title: 'Forms' });

  await client.session.prompt({ sessionID: session.id, id: 'msg_form01', text: 'ask me' });
  // A single message read is what a tool completion uses to finish a call.
  const asked = await client.session.message.get({ sessionID: session.id, messageID: 'msg_form01' });
  assert.equal(asked.id, 'msg_form01');

  // The pending form is readable both for the session and globally. These routes
  // unwrap to `value.data`, so the list is the array itself.
  let form = null;
  for (let attempt = 0; attempt < 100 && !form; attempt += 1) {
    const pending = await client.session.form.list({ sessionID: session.id });
    form = pending[0] ?? null;
    if (!form) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(form, 'a parked question becomes a pending form');
  assert.equal(form.sessionID, session.id);
  assert.equal((await client.session.form.get({ sessionID: session.id, formID: form.id })).id, form.id);

  // Answering settles it through the same authenticated ingress as a prompt.
  await client.session.form.reply({ sessionID: session.id, formID: form.id, answer: { question_0: 'stable' } });
  await client.session.wait({ sessionID: session.id });
  assert.deepEqual(await client.session.form.list({ sessionID: session.id }), []);

  // Interrupt on an idle session is an honest no-op.
  const idle = await client.session.interrupt({ sessionID: session.id });
  assert.equal(idle.interrupted, false);
  await client.session.remove({ sessionID: session.id });
});

test('the published client stages and clears a revert', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE, timeout: 20_000 }, async (t) => {
  // Why through the published client: the revert path translates a message id
  // into the engine's request id, and only the client proves it sends the id
  // shape this surface expects. Durable persistence is required by the engine.
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const { runtime, root } = await fixtureServer(t, { config: resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  const client = OpenCode.make({ baseUrl: runtime.url, headers: { 'x-opencode-directory': encodeURIComponent(root) } });
  const session = await client.session.create({ title: 'Revert client' });
  await client.session.prompt({ sessionID: session.id, id: 'msg_sdkrevert01', text: 'hello' });
  await client.session.wait({ sessionID: session.id });

  const staged = await client.session.revert.stage({ sessionID: session.id, messageID: 'msg_sdkrevert01' });
  assert.equal(staged.messageID, 'msg_sdkrevert01');
  await client.session.revert.clear({ sessionID: session.id });
  // The revert is announced on the stream the client renders from.
  const events = client.event.subscribe({ signal: AbortSignal.timeout(10_000) })[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, 'server.connected');
  await client.session.revert.stage({ sessionID: session.id, messageID: 'msg_sdkrevert01' });
  let sawStaged = false;
  for (let count = 0; count < 20; count += 1) {
    const item = await events.next(); if (item.done) break;
    if (item.value.type === 'session.revert.staged') { sawStaged = true; break; }
  }
  await events.return();
  assert.equal(sawStaged, true, 'the client must receive the staged revert');
});
