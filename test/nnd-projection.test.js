// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { nndProjection, publishNndProjection } from '../src/nnd-projection.js';
import { createWireEventBus } from '../src/opencode/wire-events.js';
import { NndEngineHost } from '../src/nnd-engine-host.js';
const owner = { subjectId: 'owner', workspaceIds: ['first', 'second'] };
const phases = ['idle', 'preparing', 'waiting_provider', 'reasoning', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'attention_required', 'cancelling', 'failed', 'needs_input'];
function frames(written) { return written.filter((text) => text.includes('data: ')).map((text) => JSON.parse(text.match(/data: (.*)\n/u)[1])); }
const response = (written) => ({ write: (value) => written.push(value) });
test('projection snapshots keep a stable epoch/revision until display data changes and rotate on restore', () => {
  const context = { sessionId: 'session-1', updatedAt: 10 };
  const first = nndProjection(context, {});
  assert.equal(first.turnState, null); assert.equal(first.revision, 1);
  assert.equal(nndProjection(context, {}), first);
  for (const phase of phases) {
    const next = nndProjection(context, { turnState: { phase }, private: 'never publish' });
    assert.equal(next.epoch, first.epoch); assert.equal(next.turnState.phase, phase);
    assert.equal(JSON.stringify(next).includes('never publish'), false);
  }
  const restored = nndProjection({ sessionId: context.sessionId, updatedAt: 1 }, {});
  assert.notEqual(restored.epoch, first.epoch); assert.equal(restored.turnState, null);
});
test('projection frames replay in order and preserve the complete owner/workspace envelope', () => {
  const bus = createWireEventBus(); const written = []; const denied = [];
  const stop = bus.subscribe(response(written), owner);
  const context = { sessionId: 'session-1', updatedAt: 10 };
  const publish = (phase) => publishNndProjection(bus, { directory: '/workspace', project: 'first', sessionID: context.sessionId,
    ...owner, type: 'session.updated', properties: { info: { metadata: { nnd: { projection: nndProjection(context, { turnState: { phase } }) } } } } });
  publish('preparing'); const cursor = frames(written).at(-1).payload.id;
  publish('waiting_provider'); publish('streaming'); stop();
  const replayed = []; bus.subscribe(response(replayed), { ...owner, lastEventId: cursor });
  const projection = frames(replayed).filter((value) => value.payload.type === 'nnd.projection');
  assert.deepEqual(projection.map((value) => value.payload.properties.frame.turnState.phase), ['waiting_provider', 'streaming']);
  bus.subscribe(response(denied), { subjectId: owner.subjectId, workspaceIds: ['first'], lastEventId: cursor });
  assert.equal(frames(denied).length, 1);
  const stranger = []; bus.subscribe(response(stranger), { subjectId: 'stranger', workspaceIds: owner.workspaceIds, lastEventId: cursor });
  assert.equal(frames(stranger).length, 1); bus.close();
});
test('owned host snapshots and emitted frames contain the same authored phase without tool arguments', async () => {
  const events = []; let output; let settle;
  const engine = { config: { workspaceRoot: '/workspace' }, transcript: [], initialize: async () => {}, shutdown: async () => {},
    submit: async () => new Promise((resolve) => { settle = resolve; }) };
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; } });
  await host.create('session-1', owner); host.submitAsync('session-1', { version: '1.0', type: 'submit', request_id: 'prompt-1', content: 'work' }, owner);
  for (const phase of phases) {
    output({ type: 'state_status', session_id: 'session-1', semantic_state: phase, secret: 'private prompt' });
    const snapshot = host.get('session-1', owner).metadata.nnd.projection;
    assert.equal(snapshot.turnState.phase, phase);
    assert.deepEqual(events.filter((event) => event.type === 'nnd.projection').at(-1).properties.frame, snapshot);
  }
  assert.equal(JSON.stringify(events.filter((event) => event.type === 'nnd.projection')).includes('private prompt'), false);
  settle({ accepted: true }); await new Promise((resolve) => setImmediate(resolve)); await host.shutdown();
});
test('delegated frames retain child identity and phase without borrowing parent state', async () => {
  const events = []; const engine = { config: { workspaceRoot: '/workspace' }, transcript: [], initialize: async () => {}, shutdown: async () => {} };
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) }, createEngine: async () => engine });
  await host.create('parent-1', owner);
  const end = host.childSessions.register('child-1', 'parent-1', owner, { config: engine.config, transcript: [] });
  host.childSessions.observeOutput('child-1', { type: 'state_status', session_id: 'child-1', semantic_state: 'reasoning' });
  const childFrame = events.filter((event) => event.type === 'nnd.projection' && event.sessionID === 'child-1').at(-1);
  assert.equal(childFrame.properties.frame.turnState.phase, 'reasoning');
  assert.equal(childFrame.subjectId, owner.subjectId); assert.deepEqual(childFrame.workspaceIds, owner.workspaceIds);
  assert.equal(host.get('parent-1', owner).metadata.nnd.projection.turnState, null);
  end('completed');
  const completed = events.filter((event) => event.type === 'nnd.projection' && event.sessionID === 'child-1').at(-1).properties.frame;
  assert.equal(completed.turnState.phase, 'idle'); assert.equal(completed.activeTools, null);
  assert.ok(completed.revision > childFrame.properties.frame.revision); await host.shutdown();
});
