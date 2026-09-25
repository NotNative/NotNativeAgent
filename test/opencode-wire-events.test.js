// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWireEventBus, wireEnvelopeShapes } from '../src/opencode/wire-events.js';

function fakeRes(written) {
  return { writableEnded: false, write: (chunk) => { written.push(chunk); } };
}

function payload(written, index) {
  const chunk = written[index];
  assert.match(chunk, /^data: .+\n\n$/u);
  return JSON.parse(chunk.slice('data: '.length));
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
