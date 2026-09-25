// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWireEventBus, wireEnvelopeShapes } from '../src/opencode/wire-events.js';

function fakeRes(written) {
  return { writableEnded: false, write: (chunk) => { written.push(chunk); } };
}

function payload(written, index) {
  const chunk = written[index];
  assert.match(chunk, /(?:^|\n)data: .+\n\n$/u);
  return JSON.parse(chunk.match(/(?:^|\n)data: (.+)\n\n$/u)[1]);
}

function frameId(written, index) {
  return written[index].match(/^id: ([^\n]+)\n/u)?.[1] ?? null;
}

test('bus frames server events under the global payload envelope and fans out', () => {
  const bus = createWireEventBus();
  const first = [];
  const second = [];
  const stopOne = bus.subscribe(fakeRes(first));
  bus.subscribe(fakeRes(second));
  bus.publishGlobal('ping', { hello: true });
  const opener = payload(first, 0);
  const ping = payload(first, 1);
  assert.deepEqual(Object.keys(opener), ['payload']);
  assert.deepEqual(Object.keys(opener.payload).sort(), ['id', 'properties', 'type']);
  assert.equal(opener.payload.type, 'server.connected');
  assert.equal(ping.payload.type, 'ping');
  assert.deepEqual(ping.payload.properties, { hello: true });
  assert.equal(first.length, second.length);
  stopOne();
  bus.publishGlobal('ping2', {});
  assert.equal(first.length, 2);
  assert.equal(second.length, 3);
  bus.close();
});

test('bus mirrors durable session events with the same id, .1 suffix, and monotonic seq', () => {
  const bus = createWireEventBus();
  const written = [];
  bus.subscribe(fakeRes(written));
  const properties = { sessionID: 'ses_1', info: { id: 'ses_1' } };
  bus.publishSession({ directory: 'C:\\w', sessionID: 'ses_1', project: 'a'.repeat(40), type: 'message.updated', properties, mirror: true, seq: 4 });
  bus.publishSession({ directory: 'C:\\w', sessionID: 'ses_1', project: 'a'.repeat(40), type: 'message.part.delta', properties: { delta: 'x' } });
  assert.equal(written.length, 4);
  const bare = payload(written, 1);
  const mirror = payload(written, 2);
  const delta = payload(written, 3);
  assert.deepEqual(Object.keys(bare).sort(), [...wireEnvelopeShapes().scoped].sort().filter((key) => ['directory', 'payload', 'project'].includes(key)).sort());
  assert.equal(bare.directory, 'C:\\w');
  assert.equal(bare.project, 'a'.repeat(40));
  assert.deepEqual(bare.payload.properties, properties);
  assert.equal(mirror.payload.properties.syncEvent.id, bare.payload.id, 'the sync mirror carries the bare event id inside syncEvent');
  assert.notEqual(mirror.payload.id, bare.payload.id, 'the mirror envelope rides its own event id');
  assert.deepEqual(mirror.payload.properties, {
    type: 'sync',
    syncEvent: { id: bare.payload.id, type: 'message.updated.1', seq: 4, aggregateID: 'ses_1', data: properties },
  });
  assert.notEqual(delta.payload.id, mirror.payload.id, 'consecutive events must not share ids');
});

test('bus filters scoped events away from mismatched directory subscribers', () => {
  const bus = createWireEventBus();
  const mine = [];
  const world = [];
  bus.subscribe(fakeRes(mine), { directory: 'C:\\mine' });
  bus.subscribe(fakeRes(world));
  bus.publishGlobal('instance.event', {});
  bus.publishSession({ directory: 'C:\\theirs', sessionID: 'ses_2', project: 'x', type: 'session.updated', properties: {} });
  bus.publishSession({ directory: 'C:\\mine', sessionID: 'ses_3', project: 'x', type: 'session.updated', properties: {} });
  assert.equal(mine.length, 3);
  assert.equal(world.length, 4);
  bus.close();
});

test('bus can scope a shared workspace to its authenticated principal', () => {
  const bus = createWireEventBus();
  const mine = [];
  const other = [];
  bus.subscribe(fakeRes(mine), { subjectId: 'user_a', workspaceIds: ['workspace_a'] });
  bus.subscribe(fakeRes(other), { subjectId: 'user_b', workspaceIds: ['workspace_a'] });
  bus.publishSession({ directory: 'C:\\workspace', project: 'workspace_a', subjectId: 'user_a', sessionID: 'ses_1', type: 'message.updated', properties: {} });
  assert.equal(mine.length, 2);
  assert.equal(other.length, 1);
  bus.close();
});

test('bus requires the complete workspace grant for a multi-workspace NND event', () => {
  const bus = createWireEventBus();
  const full = [];
  const partial = [];
  bus.subscribe(fakeRes(full), { subjectId: 'user_a', workspaceIds: ['workspace_a', 'workspace_b'] });
  bus.subscribe(fakeRes(partial), { subjectId: 'user_a', workspaceIds: ['workspace_a'] });
  bus.publishSession({ directory: 'C:\\workspace', project: 'workspace_a', workspaceIds: ['workspace_a', 'workspace_b'],
    subjectId: 'user_a', sessionID: 'ses_1', type: 'message.updated', properties: { secret: 'private' }, mirror: true });
  assert.equal(full.length, 3);
  assert.equal(partial.length, 1);
  bus.close();
});

test('bus replays an ordered bounded suffix after the SSE cursor without re-emitting the cursor', () => {
  const bus = createWireEventBus();
  const first = [];
  bus.subscribe(fakeRes(first));
  bus.publishSession({ directory: 'C:\\mine', project: 'w', sessionID: 's', type: 'session.updated', properties: { n: 1 }, mirror: true });
  const cursor = frameId(first, 1);
  assert.equal(cursor, payload(first, 1).payload.id);
  bus.publishSession({ directory: 'C:\\mine', project: 'w', sessionID: 's', type: 'session.updated', properties: { n: 2 } });
  const resumed = [];
  bus.subscribe(fakeRes(resumed), { lastEventId: cursor });
  assert.equal(payload(resumed, 0).payload.type, 'server.connected');
  assert.equal(frameId(resumed, 0), null, 'connection opener does not advance the transport cursor');
  assert.deepEqual(resumed.slice(1).map((_, index) => payload(resumed, index + 1).payload.type), ['sync', 'session.updated']);
  assert.deepEqual(resumed.slice(1).map((_, index) => frameId(resumed, index + 1)), [frameId(first, 2), frameId(first, 3)]);
  bus.close();
});

test('replay enforces principal and complete workspace grants and rejects unknown cursors', () => {
  const bus = createWireEventBus();
  const first = [];
  bus.subscribe(fakeRes(first), { subjectId: 'one', workspaceIds: ['a'] });
  bus.publishSession({ directory: 'C:\\mine', project: 'a', subjectId: 'one', workspaceIds: ['a'],
    sessionID: 's', type: 'session.updated', properties: { n: 1 } });
  const cursor = frameId(first, 1);
  bus.publishSession({ directory: 'C:\\mine', project: 'a', subjectId: 'one', workspaceIds: ['a', 'b'],
    sessionID: 's', type: 'session.updated', properties: { secret: true } });
  bus.publishSession({ directory: 'C:\\mine', project: 'a', subjectId: 'two', workspaceIds: ['a'],
    sessionID: 's', type: 'session.updated', properties: { other: true } });
  bus.publishSession({ directory: 'C:\\mine', project: 'a', subjectId: 'one', workspaceIds: ['a'],
    sessionID: 's', type: 'session.updated', properties: { n: 2 } });
  const partial = [];
  bus.subscribe(fakeRes(partial), { lastEventId: cursor, subjectId: 'one', workspaceIds: ['a'] });
  assert.deepEqual(partial.slice(1).map((_, index) => payload(partial, index + 1).payload.properties), [{ n: 2 }]);
  const unknown = [];
  bus.subscribe(fakeRes(unknown), { lastEventId: 'missing', subjectId: 'one', workspaceIds: ['a', 'b'] });
  assert.equal(unknown.length, 1);
  bus.close();
});

test('replay retention has a byte bound and never bridges an omitted oversized event', () => {
  const bus = createWireEventBus();
  const first = [];
  const stop = bus.subscribe(fakeRes(first));
  bus.publishSession({ directory: 'C:\\mine', project: 'w', sessionID: 's', type: 'session.updated', properties: { n: 1 } });
  const cursor = frameId(first, 1);
  stop();
  // One event larger than the 16 MiB retention budget invalidates the prior
  // suffix, even when later events can themselves fit in the ring.
  bus.publishSession({ directory: 'C:\\mine', project: 'w', sessionID: 's', type: 'message.part.updated',
    properties: { text: 'x'.repeat(16 * 1024 * 1024) } });
  bus.publishSession({ directory: 'C:\\mine', project: 'w', sessionID: 's', type: 'session.updated', properties: { n: 2 } });
  const resumed = [];
  bus.subscribe(fakeRes(resumed), { lastEventId: cursor });
  assert.equal(resumed.length, 1, 'an old cursor cannot skip across an omitted frame');
  bus.close();

  const bounded = createWireEventBus();
  const initial = [];
  const stopInitial = bounded.subscribe(fakeRes(initial));
  bounded.publishGlobal('first', {});
  const oldCursor = frameId(initial, 1);
  stopInitial();
  const largeProperties = { text: 'x'.repeat(9 * 1024 * 1024) };
  bounded.publishGlobal('large', largeProperties);
  bounded.publishGlobal('large', largeProperties);
  const afterEviction = [];
  bounded.subscribe(fakeRes(afterEviction), { lastEventId: oldCursor });
  assert.equal(afterEviction.length, 1, 'aggregate byte pressure evicts the old cursor');
  bounded.close();
});
