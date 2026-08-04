// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from '../src/events.js';
import { StateAuthority } from '../src/lifecycle.js';
import { EventFactory } from '../src/event-factory.js';
import { declaredSubscription } from './event-fixture.js';

test('AC-STATE-02 rejects an illegal transition without changing state', () => {
  const authority = new StateAuthority();
  assert.throws(
    () => authority.transition('executing_tools', { trigger: 'test', turnId: 'turn-1' }),
    { code: 'illegal_transition' },
  );
  assert.equal(authority.state, 'idle');
  assert.equal(authority.transitions[0].guard, 'rejected');
});

test('AC-STATE-03 exit failure preserves source while entry failure commits destination for recovery', () => {
  const authority = new StateAuthority();
  assert.throws(() => authority.transition('preparing_turn', {
    trigger: 'exit-failure', exitEffect: () => { throw new Error('exit failed'); },
  }), /exit failed/u);
  assert.equal(authority.state, 'idle');
  assert.throws(() => authority.transition('preparing_turn', {
    trigger: 'entry-failure', entryEffect: () => { throw new Error('entry failed'); },
  }), (error) => {
    assert.equal(error.name, 'TransitionEntryError');
    assert.equal(error.transition.to, 'preparing_turn');
    return true;
  });
  assert.equal(authority.state, 'preparing_turn');
});

test('AC-STATE-01/AC-EVENT-08 observers receive immutable snapshots and schedule before ordered blockers', async () => {
  const hub = new EventHub();
  const order = [];
  let release;
  const observerDone = new Promise((resolve) => { release = resolve; });
  hub.register(declaredSubscription({
    id: 'observer', category: 'turn', phase: 'pre', blocking: false,
    timeoutMs: 100, failurePolicy: 'continue',
  }), async (event) => {
    order.push('observer');
    assert.throws(() => { event.payload.authoritative = 'mutated'; }, TypeError);
    release();
  });
  for (const [id, priority] of [['second', 20], ['first', 10]]) hub.register(declaredSubscription({
    id, category: 'turn', phase: 'pre', blocking: true,
    priority, timeoutMs: 100, failurePolicy: 'deny',
  }), async (event) => { order.push(id); assert.equal(event.payload.authoritative, 'original'); return { decision: 'continue' }; });
  const source = { category: 'turn', phase: 'pre', payload: { authoritative: 'original' } };
  const result = await hub.dispatch(source);
  await observerDone;
  assert.equal(result.decision, 'continue');
  assert.deepEqual(order, ['observer', 'first', 'second']);
  assert.equal(source.payload.authoritative, 'original');
  await hub.close();
});

test('AC-EVENT-02 event identities and session order remain correlated independently of wall clock', () => {
  const factory = new EventFactory('runtime-1', 'session-1');
  const parent = factory.create('model_step.started', 'model_step', 'active', {
    turnId: 'turn-1', stepId: 'step-1', logicalRequestId: 'logical-1',
  });
  const child = factory.create('provider_attempt.active', 'provider_attempt', 'active', {
    turnId: 'turn-1', stepId: 'step-1', attemptId: 'attempt-1', logicalRequestId: 'logical-1',
  });
  const childTerminal = factory.create('provider_attempt.terminal', 'provider_attempt', 'terminal', {
    turnId: 'turn-1', stepId: 'step-1', attemptId: 'attempt-1', logicalRequestId: 'logical-1',
  }, {}, 'completed');
  const parentTerminal = factory.create('model_step.terminal', 'model_step', 'terminal', {
    turnId: 'turn-1', stepId: 'step-1', logicalRequestId: 'logical-1',
  }, {}, 'completed');
  const records = [parent, child, childTerminal, parentTerminal];
  assert.equal(new Set(records.map((item) => item.event_id)).size, 4);
  assert.deepEqual(records.map((item) => item.sequence), [1, 2, 3, 4]);
  assert.equal(records.every((item) => item.session_id === 'session-1' && item.turn_id === 'turn-1'), true);
  assert.equal(child.attempt_id, childTerminal.attempt_id);
});

test('AC-EVENT-03 orders blocking subscriptions by priority then registration', async () => {
  const hub = new EventHub();
  const observed = [];
  const add = (id, priority) => hub.register(declaredSubscription({
    id, category: 'turn', phase: 'pre', blocking: true,
    priority, timeoutMs: 100, failurePolicy: 'deny',
  }), async () => { observed.push(id); return { decision: 'continue' }; });
  add('twenty-a', 20);
  add('ten', 10);
  add('twenty-b', 20);
  const result = await hub.dispatch({ category: 'turn', phase: 'pre' });
  assert.equal(result.decision, 'continue');
  assert.deepEqual(observed, ['ten', 'twenty-a', 'twenty-b']);
});

test('AC-EVENT-05 critical timeout denies and observer failure is isolated', async () => {
  const hub = new EventHub();
  hub.register(declaredSubscription({
    id: 'observer', category: 'turn', phase: 'pre', blocking: false,
    priority: 0, timeoutMs: 20, failurePolicy: 'continue',
  }), async () => { throw new Error('observer failed'); });
  hub.register(declaredSubscription({
    id: 'safety', category: 'turn', phase: 'pre', blocking: true,
    priority: 1, timeoutMs: 5, failurePolicy: 'deny',
  }), async () => new Promise(() => {}));
  const result = await hub.dispatch({ category: 'turn', phase: 'pre' });
  assert.equal(result.decision, 'deny');
  await hub.drain();
});

test('AC-EVENT-01 rejects undefined phases before handler execution', () => {
  const hub = new EventHub();
  let called = false;
  assert.throws(() => hub.register(declaredSubscription({
    id: 'bad', category: 'turn', phase: 'unknown', blocking: false,
  }), () => { called = true; }), { code: 'invalid_event_phase' });
  assert.equal(called, false);
});

test('AC-EVENT-07 bounds nonblocking observers and reports overflow without delaying dispatch', async () => {
  const hub = new EventHub({ maxBackground: 2 });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  for (const id of ['one', 'two', 'three']) hub.register(declaredSubscription({
    id, category: 'diagnostic', phase: 'committed', blocking: false,
    timeoutMs: 100, failurePolicy: 'continue',
  }), async () => blocked);
  const result = await hub.dispatch({ category: 'diagnostic', phase: 'committed' });
  assert.deepEqual(result.observers, { scheduled: 2, queued: 2, dropped: 1 });
  assert.deepEqual(hub.health(), {
    status: 'ready', queued: 2, running: 2, capacity: 2, dropped: 1, overflowPolicy: 'drop_newest_noncritical',
  });
  release();
  await hub.close();
  assert.equal(hub.health().status, 'closed');
});

test('event subscription timeouts and policies are bounded at registration', () => {
  const hub = new EventHub();
  assert.throws(() => hub.register(declaredSubscription({
    id: 'unbounded', category: 'turn', phase: 'pre', blocking: false,
    timeoutMs: 0, failurePolicy: 'continue',
  }), () => undefined), { code: 'invalid_subscription_bound' });
  assert.throws(() => hub.register(declaredSubscription({
    id: 'unknown-policy', category: 'turn', phase: 'pre', blocking: false,
    timeoutMs: 10, failurePolicy: 'ignore_everything',
  }), () => undefined), { code: 'invalid_subscription' });
});

test('AC-EVENT-08 subscriptions require complete declarations and collision-free identity', async () => {
  const hub = new EventHub();
  assert.throws(() => hub.register({
    id: 'incomplete', category: 'turn', phase: 'pre', blocking: true,
    priority: 0, timeoutMs: 100, failurePolicy: 'deny',
  }, () => undefined), { code: 'invalid_subscription' });
  const declaration = declaredSubscription({
    id: 'complete', category: 'turn', phase: 'pre', blocking: true,
  });
  let calls = 0;
  hub.register(declaration, () => { calls += 1; return { decision: 'continue' }; });
  assert.throws(() => hub.register(declaration, () => undefined), { code: 'subscription_identity_collision' });
  declaration.phase = 'terminal';
  declaration.resourceBounds = { maxOutputBytes: 1, maxConcurrent: 99 };
  await hub.dispatch({ category: 'turn', phase: 'pre' });
  assert.equal(calls, 1);
  assert.throws(() => hub.register(declaredSubscription({
    id: 'wrong-cancellation', category: 'turn', phase: 'pre', blocking: true,
    cancellation: 'detach',
  }), () => undefined), { code: 'invalid_subscription' });
});

test('AC-EVENT-05/AC-EVENT-08 cancellation propagates to blockers while terminal denial is observational', async () => {
  const hub = new EventHub();
  let subscriberSignal;
  hub.register(declaredSubscription({
    id: 'cancellable', category: 'turn', phase: 'pre', blocking: true,
  }), async (_event, signal) => {
    subscriberSignal = signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = hub.dispatch({ category: 'turn', phase: 'pre' }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('operator_cancelled');
  assert.equal((await pending).decision, 'deny');
  assert.equal(subscriberSignal.aborted, true);

  hub.register(declaredSubscription({
    id: 'terminal-policy', category: 'turn', phase: 'terminal', blocking: true,
  }), async () => ({ decision: 'deny', code: 'too_late' }));
  const terminal = await hub.dispatch({ category: 'turn', phase: 'terminal' });
  assert.equal(terminal.decision, 'continue');
  assert.equal(terminal.results[0].decision, 'deny');
});

test('AC-EVENT-06/AC-EVENT-08 declared output and concurrency bounds are enforced', async () => {
  const hub = new EventHub({ maxBackground: 4 });
  hub.register(declaredSubscription({
    id: 'bounded-output', category: 'turn', phase: 'pre', blocking: true,
    resourceBounds: { maxOutputBytes: 8, maxConcurrent: 1 },
  }), async () => ({ content: 'far too large' }));
  assert.equal((await hub.dispatch({ category: 'turn', phase: 'pre' })).decision, 'deny');

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  hub.register(declaredSubscription({
    id: 'bounded-concurrency', category: 'diagnostic', phase: 'committed', blocking: false,
    resourceBounds: { maxOutputBytes: 100, maxConcurrent: 1 },
  }), async () => pending);
  const first = await hub.dispatch({ category: 'diagnostic', phase: 'committed' });
  const second = await hub.dispatch({ category: 'diagnostic', phase: 'committed' });
  assert.equal(first.observers.scheduled, 1);
  assert.equal(second.observers.scheduled, 0);
  assert.equal(second.observers.dropped, 1);
  release({ ok: true });
  await hub.close();
});
