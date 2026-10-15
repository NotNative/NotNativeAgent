// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runNndSessionFork } from '../src/nnd-session-fork.js';

function fixture(settled = true) {
  const transcript = [
    { type: 'message', role: 'user', turnId: 't1', requestId: 'request1' },
    { type: 'message', role: 'assistant', turnId: 't1' },
    { type: 'message', role: 'user', turnId: 't2', requestId: 'request2' },
    { type: 'message', role: 'assistant', turnId: 't2' },
  ];
  const records = transcript.map(payload => ({ type: 'message', payload }));
  records.splice(2, 0, { type: 'turn_outcome', payload: { turnId: 't1' } });
  if (settled) records.push({ type: 'turn_outcome', payload: { turnId: 't2' } });
  const context = { sessionId: 'parent', title: 'Parent', directory: '/workspace',
    workspaceBinding: { id: 'ws_test' }, reviewMode: 'unattended',
    modelRoute: { providerId: 'chosen', model: 'chosen-model' },
    engine: { transcript, store: { readRecords: async () => ({ records }) } } };
  let created;
  const callbacks = { createContext: async (id, options) => { created = { id, options }; }, get: () => created };
  return { context, callbacks, created: () => created };
}

test('sidebar fork includes the latest settled turn and inherits workspace, route, and review', async () => {
  const { context, callbacks } = fixture();
  const child = await runNndSessionFork(context, callbacks, {});
  assert.equal(child.options.forkIngest.boundaryMessageId, 'parent:message:3');
  assert.equal(child.options.forkIngest.records.at(-1).payload.turnId, 't2');
  assert.deepEqual(child.options.modelRoute, context.modelRoute);
  assert.equal(child.options.workspace_id, 'ws_test');
  assert.equal(child.options.reviewMode, 'unattended');
});

test('an explicit fork boundary and route keep their existing semantics', async () => {
  const { context, callbacks } = fixture();
  const child = await runNndSessionFork(context, callbacks, { messageID: 'request1', providerID: 'other', model: 'other-model' });
  assert.equal(child.options.forkIngest.records.at(-1).payload.turnId, 't1');
  assert.deepEqual(child.options.modelRoute, { providerId: 'other', model: 'other-model' });
});

test('sidebar fork never creates a child from busy, empty, or unsettled history', async () => {
  for (const state of ['busy', 'empty', 'unsettled', 'invalid']) {
    const { context, callbacks, created } = fixture(state !== 'unsettled');
    if (state === 'busy') context.liveTurn = {};
    if (state === 'empty') context.engine.transcript = [];
    await assert.rejects(runNndSessionFork(context, callbacks, state === 'invalid' ? { messageID: '' } : {}));
    assert.equal(created(), undefined);
  }
});
