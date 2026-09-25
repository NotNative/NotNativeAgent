import test from 'node:test';
import assert from 'node:assert/strict';
import { NndEngineHost } from '../src/nnd-engine-host.js';

const owner = { subjectId: 'user_a', workspaceIds: ['workspace_a'] };

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
  const host = new NndEngineHost({ createEngine: async () => fakeEngine() });
  await host.create('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_a', 'workspace_b'] });
  assert.throws(
    () => host.get('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_b'] }),
    { code: 'nnd_session_unavailable' },
  );
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
    'session.created', 'session.status', 'message.updated', 'message.part.updated', 'session.status', 'session.idle', 'session.updated',
  ]);
  assert.equal(events[1].properties.status.type, 'busy');
  assert.equal(events.at(-3).properties.status.type, 'idle');
});

function steer(request_id) { return { version: '1.0', type: 'steer', request_id, content: 'continue' }; }

function fakeEngine() {
  return {
    config: { executionManifest: null }, active: null,
    async initialize() {}, async steer(command) { return { accepted: true, request_id: command.request_id }; },
    async shutdown() {},
  };
}
