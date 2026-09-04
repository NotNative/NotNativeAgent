// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProtocolLine } from '../src/contracts.js';
import { EventHub } from '../src/events.js';
import { persistEngineRecord } from '../src/engine/persistence.js';
import { ContractError, newId, requireExternalId } from '../src/ids.js';
import { StateAuthority } from '../src/lifecycle.js';
import { ConversationWork } from '../src/conversation-work.js';
import { projectConversationWork } from '../src/conversation-work-projection.js';
import { toolProgressEvidence } from '../src/reliability/tool-progress.js';

test('protocol line boundary rejects nontext and normalizes absent limit objects', () => {
  for (const input of [undefined, null, 3, {}, Buffer.from('{}')]) {
    assert.throws(() => parseProtocolLine(input), { code: 'malformed_json' });
  }
  const line = JSON.stringify({ type: 'cancel', request_id: 'r', version: '1.0' });
  assert.equal(parseProtocolLine(line, null).type, 'cancel');
});

test('falsy subscriber failures retain deny policy and successful marker objects stay successful', async () => {
  for (const failure of [null, undefined, 0, '', false, NaN]) {
    const failures = []; const hub = new EventHub({ observer: { subscriberFailed: (...args) => failures.push(args[3]) } });
    hub.register({ id: 'guard', category: 'permission', phase: 'pre', blocking: true, priority: 0,
      timeoutMs: 100, failurePolicy: 'deny', cancellation: 'propagate', inputContract: 'event', outputContract: 'decision',
      origin: 'test', trust: 'trusted', resourceBounds: { maxOutputBytes: 1024, maxConcurrent: 1 } }, async () => { throw failure; });
    assert.equal((await hub.dispatch({ category: 'permission', phase: 'pre' })).decision, 'deny');
    assert.equal(failures.length, 1); assert.ok(Object.is(failures[0], failure)); await hub.close();
  }
  const hub = new EventHub();
  hub.register({ id: 'observer', category: 'permission', phase: 'pre', blocking: true, priority: 0,
    timeoutMs: 100, failurePolicy: 'deny', cancellation: 'propagate', inputContract: 'event', outputContract: 'decision',
    origin: 'test', trust: 'trusted', resourceBounds: { maxOutputBytes: 1024, maxConcurrent: 1 } }, async () => ({ timeout: true }));
  assert.equal((await hub.dispatch({ category: 'permission', phase: 'pre' })).decision, 'continue'); await hub.close();
});

test('persistence reports and preserves primitive rejection reasons', async () => {
  for (const failure of [null, undefined, 'disk full']) {
    const reports = [];
    const engine = { store: { append: async () => { throw failure; } }, transcript: [],
      telemetry: { record: (...args) => reports.push(args) } };
    let caught = false;
    try { await persistEngineRecord(engine, 'message', {}); } catch (error) { caught = true; assert.equal(error, failure); }
    assert.equal(caught, true); assert.equal(reports.at(-1)[1], 'failed'); assert.deepEqual(engine.transcript, []);
  }
});

test('identifier errors are initialized before importer calls', () => {
  assert.throws(() => newId(''), (error) => error instanceof ContractError && error.code === 'invalid_id_prefix');
  assert.throws(() => requireExternalId(null), (error) => error instanceof ContractError && error.code === 'invalid_id');
});

test('transition context is validated before audit or state mutation', () => {
  for (const context of [undefined, null, 'x', {}, { trigger: 2 }, { trigger: 'test', turnId: {} }]) {
    const authority = new StateAuthority();
    assert.throws(() => authority.transition('preparing_turn', context), { code: 'lifecycle_context_invalid' });
    assert.equal(authority.state, 'idle'); assert.deepEqual(authority.transitions, []);
  }
});

test('work projection rejects malformed records while current completion error is already descriptive', async () => {
  const work = new ConversationWork(); await work.setGoal('Test'); const valid = work.snapshot();
  for (const snapshot of [{ ...valid, goal: undefined }, { ...valid, goal: 2 }, { ...valid, revision: -1 },
    { ...valid, tasks: [null] }, { ...valid, tasks: [{ id: 'T1', title: 'a', status: 'typo' }] }]) {
    assert.throws(() => projectConversationWork(snapshot), { code: 'work_snapshot_invalid' });
  }
  assert.equal(projectConversationWork(valid).objective, 'Test');
  await assert.rejects(work.completeGoal(''), (error) => error.code === 'work_text_invalid' && error.message.includes('goal completion evidence'));
});

test('incomplete tool observations do not crash or manufacture progress', () => {
  for (const item of [null, {}, { result: { status: 'succeeded' } }, { result: { status: 'succeeded', content: {} } }]) {
    assert.equal(toolProgressEvidence([item]), null);
  }
  assert.equal(toolProgressEvidence([{ result: { status: 'succeeded', content: '', tool_name: 'fs.list' } }])
    .detail.summary.successful_tool_calls, 1);
});
