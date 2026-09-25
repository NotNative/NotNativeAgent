import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';

const owner = { subjectId: 'user_a', workspaceIds: ['workspace_a'] };

test('NND durable catalog restores owned sessions and removes closed sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-catalog-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner, { title: 'Continued work' });
  await first.shutdown();
  const second = makeHost();
  await second.initialize();
  assert.deepEqual(second.list(owner).map((session) => session.title), ['Continued work']);
  assert.equal(second.get('session_a', owner).id, 'session_a');
  assert.deepEqual(second.list({ subjectId: 'other', workspaceIds: owner.workspaceIds }), []);
  await second.close('session_a', owner);
  assert.deepEqual(JSON.parse(await readFile(catalogPath, 'utf8')), []);
});

test('NND durable catalog refuses malformed records without discarding them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-catalog-invalid-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  await writeFile(catalogPath, '[{"sessionId":"../escape"}]');
  const host = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(host.initialize(), { code: 'nnd_catalog_invalid' });
  assert.match(await readFile(catalogPath, 'utf8'), /escape/u);
});

test('NND rename persists only after a successful catalog write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-rename-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner, { title: 'Original' });
  const createdUpdatedAt = first.get('session_a', owner).time.updated;
  await assert.rejects(first.rename('session_a', owner, ''), { code: 'session_name_invalid' });
  assert.equal((await first.rename('session_a', owner, '  Renamed  ')).title, 'Renamed');
  assert.ok(first.get('session_a', owner).time.updated > createdUpdatedAt);
  await first.shutdown();
  const reopened = makeHost();
  await reopened.initialize();
  assert.equal(reopened.get('session_a', owner).title, 'Renamed');
  assert.equal(reopened.get('session_a', owner).time.updated, first.get('session_a', owner).time.updated);

  const failed = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      if (records[0]?.title === 'Uncommitted') throw new Error('write failed');
    },
  });
  await failed.create('session_b', owner, { title: 'Stable' });
  const stableUpdatedAt = failed.get('session_b', owner).time.updated;
  await assert.rejects(failed.rename('session_b', owner, 'Uncommitted'), /write failed/u);
  assert.equal(failed.get('session_b', owner).title, 'Stable');
  assert.equal(failed.get('session_b', owner).time.updated, stableUpdatedAt);
});

test('NND archive and restore retain durable list semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-archive-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner);
  const createdUpdatedAt = first.get('session_a', owner).time.updated;
  await assert.rejects(first.setArchived('session_a', owner, -1), { code: 'request_invalid' });
  await first.setArchived('session_a', owner, 12345);
  assert.deepEqual(first.list(owner), []);
  assert.equal(first.list(owner, { includeArchived: true })[0].time.archived, 12345);
  const archivedUpdatedAt = first.get('session_a', owner).time.updated;
  assert.ok(archivedUpdatedAt > createdUpdatedAt);
  await first.shutdown();
  const reopened = makeHost();
  await reopened.initialize();
  assert.deepEqual(reopened.list(owner), []);
  assert.equal(reopened.list(owner, { includeArchived: true })[0].time.archived, 12345);
  assert.equal(reopened.get('session_a', owner).time.updated, archivedUpdatedAt);
  await reopened.setArchived('session_a', owner, 0);
  assert.equal(reopened.list(owner)[0].time.archived, undefined);
  assert.ok(reopened.get('session_a', owner).time.updated > archivedUpdatedAt);
});

test('NND session directory follows the initialized engine and later workspace transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-directory-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  await writeFile(catalogPath, JSON.stringify([{
    sessionId: 'session_a', subjectId: owner.subjectId, workspaceIds: owner.workspaceIds,
    title: 'Older session', directory: '', createdAt: Date.now(),
  }]));
  let engine;
  const host = new NndEngineHost({ catalogPath, createEngine: async () => {
    const next = fakeEngine();
    next.config = { workspaceRoot: root };
    engine ??= next;
    return next;
  } });
  await host.initialize();
  assert.equal(host.get('session_a', owner).directory, root);
  assert.equal(host.get('session_a', owner).time.updated, host.get('session_a', owner).time.created);
  const nextRoot = join(root, 'next');
  engine.config = { workspaceRoot: nextRoot };
  assert.equal(host.list(owner)[0].directory, nextRoot);
  await host.create('session_b', owner);
  const records = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.equal(records.find((record) => record.sessionId === 'session_a').directory, nextRoot);
});

test('NND catalog excludes a failed concurrent create from the next durable write', async () => {
  let firstWrite;
  const firstStarted = new Promise((resolve) => { firstWrite = resolve; });
  let rejectFirst;
  const firstPending = new Promise((resolve, reject) => { rejectFirst = reject; });
  const durable = [];
  let writes = 0;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      writes += 1;
      if (writes === 1) { firstWrite(); await firstPending; }
      durable.push(records.map((record) => record.sessionId));
    },
  });
  const failed = host.create('session_a', owner);
  await firstStarted;
  const accepted = host.create('session_b', owner);
  rejectFirst(new Error('catalog write failed'));
  await assert.rejects(failed, /catalog write failed/u);
  await accepted;
  assert.deepEqual(durable, [['session_b']]);
  assert.deepEqual(host.list(owner).map((session) => session.id), ['session_b']);
});

test('NND catalog retains a closing session while another session is created', async () => {
  const durable = [];
  let failClose = false;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      if (failClose && records.every((record) => record.sessionId !== 'session_a')) throw new Error('catalog write failed');
      durable.push(records.map((record) => record.sessionId));
    },
  });
  await host.create('session_a', owner);
  failClose = true;
  await assert.rejects(host.close('session_a', owner), /catalog write failed/u);
  await host.create('session_b', owner);
  assert.deepEqual(durable.at(-1), ['session_a', 'session_b']);
});

test('NND catalog refuses a write that cannot be reopened within its size bound', async () => {
  let writes = 0;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async () => { writes += 1; },
  });
  const largePrincipal = { subjectId: 'user_a', workspaceIds: Array.from({ length: 400 }, (_, index) => `${index}_${'x'.repeat(250)}`) };
  for (let index = 0; index < 9; index += 1) await host.create(`session_${index}`, largePrincipal);
  await assert.rejects(host.create('session_9', largePrincipal), { code: 'nnd_catalog_capacity' });
  assert.equal(writes, 9);
  assert.equal(host.list(largePrincipal).length, 9);
});

test('NND engine host binds each context to its authenticated owner', async () => {
  const created = [];
  const host = new NndEngineHost({ createEngine: async (options) => {
    created.push(options);
    return fakeEngine();
  } });
  await host.create('session_a', owner);
  assert.equal(created[0].nndSessionRegistry, host.childSessions);
  await assert.rejects(() => host.submit('session_a', steer('request_a'), { subjectId: 'user_b', workspaceIds: ['workspace_a'] }), { code: 'nnd_session_unavailable' });
  assert.deepEqual(await host.submit('session_a', steer('request_a'), owner), { accepted: true, request_id: 'request_a' });
  assert.deepEqual(await host.close('session_a', owner), { closed: true });
  await assert.rejects(() => host.submit('session_a', steer('request_b'), owner), { code: 'nnd_session_unavailable' });
});

test('NND engine host requires the entire original workspace grant', async () => {
  const events = [];
  const host = new NndEngineHost({ createEngine: async () => fakeEngine(),
    eventBus: { publishSession: (event) => events.push(event) } });
  await host.create('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_a', 'workspace_b'] });
  assert.deepEqual(events[0].workspaceIds, ['workspace_a', 'workspace_b']);
  assert.throws(
    () => host.get('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_b'] }),
    { code: 'nnd_session_unavailable' },
  );
});

test('NND engine host lists child sessions and projects their retained transcripts', async () => {
  const host = new NndEngineHost({ createEngine: async () => fakeEngine() });
  await host.create('session_a', owner);
  const child = { config: { workspaceRoot: 'D:\\work' }, active: { finalized: false }, transcript: [
    { type: 'message', role: 'user', content: 'Inspect this' },
    { type: 'message', role: 'assistant', content: 'Done' },
  ] };
  const stop = host.childSessions.register('agent_coder_1', 'session_a', owner, child, { type: 'coder' });
  assert.equal(host.list(owner).length, 2);
  assert.equal(host.get('agent_coder_1', owner).parentID, 'session_a');
  assert.equal(host.statuses(owner).agent_coder_1.type, 'busy');
  assert.deepEqual(host.messages('agent_coder_1', owner).map(({ info, parts }) => [info.id, parts[0].text]), [
    ['agent_coder_1:message:0', 'Inspect this'], ['agent_coder_1:message:1', 'Done'],
  ]);
  stop();
  assert.deepEqual(host.statuses(owner), {});
  assert.equal(host.messages('agent_coder_1', owner)[1].parts[0].text, 'Done');
  await host.close('session_a', owner);
  assert.equal(host.list(owner).length, 0);
  assert.throws(() => host.messages('agent_coder_1', owner), { code: 'nnd_session_unavailable' });
});

test('NND engine host reserves capacity during creation and cleans up a failed initialization', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let shutdowns = 0;
  const host = new NndEngineHost({ limit: 1, createEngine: async () => {
    await ready;
    return { ...fakeEngine(), async initialize() { throw new Error('initialization failed'); }, async shutdown() { shutdowns += 1; } };
  } });
  const creating = host.create('session_a', owner);
  await assert.rejects(() => host.create('session_b', owner), { code: 'nnd_context_capacity' });
  await assert.rejects(() => host.create('session_a', owner), { code: 'nnd_session_exists' });
  release();
  await assert.rejects(creating, /initialization failed/u);
  assert.equal(shutdowns, 1);
});

test('NND engine host revokes child grants and retains a failed close for retry', async () => {
  let shutdownAttempts = 0;
  let revoked = 0;
  const childSessions = { unregisterParent: (sessionId) => { assert.equal(sessionId, 'session_a'); revoked += 1; } };
  const host = new NndEngineHost({ childSessions, createEngine: async () => ({
    ...fakeEngine(), async shutdown() {
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw new Error('shutdown failed');
    },
  }) });
  await host.create('session_a', owner);
  await assert.rejects(() => host.close('session_a', owner), /shutdown failed/u);
  assert.equal(revoked, 1);
  await assert.rejects(() => host.submit('session_a', steer('request_a'), owner), { code: 'nnd_session_unavailable' });
  assert.deepEqual(await host.close('session_a', owner), { closed: true });
});

test('NND engine host acknowledges prompt_async work and keeps transcript IDs stable', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'first' }];
  engine.submit = async () => pending;
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: true, request_id: 'prompt_a' });
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: false, duplicate: true, pending: true });
  engine.transcript.push(...Array.from({ length: 201 }, (_, index) => ({ type: 'message', role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })));
  const messages = host.messages('session_a', owner);
  assert.equal(messages.length, 200);
  assert.equal(messages[0].info.id, 'session_a:message:2');
  release();
});

test('NND engine host rejects a prompt while its engine has an active turn', async () => {
  const engine = fakeEngine();
  engine.active = { finalized: false };
  let submissions = 0;
  engine.submit = async () => { submissions += 1; };
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: false, reason: 'busy' });
  assert.equal(submissions, 0);
});

test('NND engine host publishes a busy-to-idle reconciliation sequence', async () => {
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'hello' }];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async () => engine,
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.type), [
    'session.created', 'session.status', 'nnd.activity', 'message.updated', 'message.part.updated',
    'nnd.activity', 'session.status', 'session.idle', 'session.updated',
  ]);
  assert.equal(events[1].properties.status.type, 'busy');
  assert.equal(events.at(-3).properties.status.type, 'idle');
});

test('NND engine host streams text and tool activity before authoritative completion', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'hello' }];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'stream_delta', session_id: 'different', turn_id: 'turn_a', text: 'private' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'Hello' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_b', text: 'wrong turn' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: ' world' });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'running', arguments: { secret: 'do-not-expose' } });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'succeeded' });
  assert.deepEqual(events.filter((event) => event.type === 'message.part.updated').map((event) => event.properties.part.text), ['Hello']);
  assert.deepEqual(events.filter((event) => event.type === 'message.part.delta').map((event) => event.properties.delta), [' world']);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'tool').at(-1).properties.status, 'completed');
  assert.equal(JSON.stringify(events).includes('do-not-expose'), false);
  assert.equal(events.some((event) => event.type === 'message.removed'), false);
  engine.transcript.push({ type: 'message', role: 'assistant', content: 'Hello world' });
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'completed' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const removed = events.findIndex((event) => event.type === 'message.removed');
  const canonical = events.findIndex((event, index) => index > removed && event.type === 'message.updated' && event.properties.info.id === 'session_a:message:1');
  assert.ok(removed > 0 && canonical > removed);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'completed');
});

test('NND live turn cannot be replaced before the engine marks itself active', async () => {
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  let submissions = 0;
  engine.submit = async () => { submissions += 1; return new Promise((resolve) => { release = resolve; }); };
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async () => engine,
  });
  await host.create('session_a', owner);
  const first = { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' };
  assert.equal(host.submitAsync('session_a', first, owner).accepted, true);
  assert.deepEqual(host.submitAsync('session_a', { ...first, request_id: 'prompt_b' }, owner), { accepted: false, reason: 'busy' });
  assert.deepEqual(host.submitAsync('session_a', first, owner), { accepted: false, duplicate: true, pending: true });
  assert.equal(submissions, 1);
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 0);
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 1);
});

test('NND preview is bounded and a failing subscriber cannot fail the governed turn', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => {
      events.push(event);
      if (event.type === 'message.part.updated') throw new Error('subscriber broke');
    } },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  const first = { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' };
  assert.equal(host.submitAsync('session_a', first, owner).accepted, true);
  assert.doesNotThrow(() => output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'x'.repeat(300_000) }));
  assert.equal(events.find((event) => event.type === 'message.part.updated').properties.part.text.length, 262_144);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'notice').length, 1);
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'additional' });
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'notice').length, 1);
  release({ accepted: false, reason: 'provider_failed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'failed');
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 1);
});

test('NND activity does not label an intentional cancellation as a failure', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'cancelled' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties;
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.summary, 'Turn cancelled');
});

test('NND activity reports a governed denial as a failed turn', async () => {
  let output;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => ({ accepted: true });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'denied' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'failed');
});

function steer(request_id) { return { version: '1.0', type: 'steer', request_id, content: 'continue' }; }

function fakeEngine() {
  return {
    config: { executionManifest: null }, active: null,
    async initialize() {}, async steer(command) { return { accepted: true, request_id: command.request_id }; },
    async shutdown() {},
  };
}
