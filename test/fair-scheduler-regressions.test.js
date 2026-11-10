// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { FairScheduler } from '../src/provider/fair-scheduler.js';

test('one limited model cannot have its shared provider capacity raised by a later request', async () => {
  const scheduler = new FairScheduler({ limit: 4 });
  const signal = new AbortController().signal;
  const first = await scheduler.acquire('shared', 'small', signal, () => undefined, 1);
  let entered = false;
  const waiting = scheduler.acquire('shared', 'large', signal, () => undefined, 4).then((release) => {
    entered = true;
    assert.equal(scheduler.snapshot()[0].limit, 4);
    release();
  });
  await Promise.resolve();
  assert.equal(entered, false);
  assert.equal(scheduler.snapshot()[0].limit, 1);
  first();
  await waiting;
  assert.equal(entered, true);
});

test('a full provider queue rejects asynchronously without changing its grants', async () => {
  const scheduler = new FairScheduler({ limit: 1, maxQueued: 1 });
  const first = await scheduler.acquire('shared', 'first', new AbortController().signal);
  const controller = new AbortController();
  const waiting = scheduler.acquire('shared', 'second', controller.signal);
  const rejected = scheduler.acquire('shared', 'third', new AbortController().signal);
  await assert.rejects(rejected, { code: 'scheduler_queue_full' });
  assert.equal(scheduler.snapshot()[0].queued.length, 1);
  controller.abort();
  await assert.rejects(waiting, { code: 'scheduler_cancelled' });
  first();
  assert.equal(scheduler.snapshot()[0].running, 0);
});

test('throwing queue observation cannot reject or retain admitted work', async () => {
  const scheduler = new FairScheduler({ limit: 1 });
  const signal = new AbortController().signal;
  const first = await scheduler.acquire('shared', 'first', signal);
  const waiting = scheduler.acquire('shared', 'second', signal, () => { throw new Error('observer failed'); });
  assert.equal(scheduler.snapshot()[0].queued.length, 1);
  first();
  const second = await waiting;
  assert.equal(scheduler.snapshot()[0].running, 1);
  assert.equal(scheduler.snapshot()[0].queued.length, 0);
  second();
  assert.equal(scheduler.snapshot()[0].running, 0);
});

test('a declared ceiling caps discovery and is a hard bound that only the operator lowers', async () => {
  const scheduler = new FairScheduler({ limit: 4 });
  const signal = new AbortController().signal;
  // The operator declares two; a provider claiming eight must not widen it.
  scheduler.setDeclaredLimit('local', 2);
  scheduler.setDiscoveredLimit('local', 8);
  const releases = [];
  for (let index = 0; index < 4; index += 1) {
    releases.push(scheduler.acquire('local', `owner_${index}`, signal, () => undefined));
    if (index < 2) releases[index] = await releases[index];
  }
  await Promise.resolve();
  // Two admitted, the rest held: the declared bound is the effective limit.
  assert.equal(scheduler.snapshot()[0].running, 2);
  assert.equal(snapshotLimit(scheduler), 2);
  // Declaring one further lowers the ceiling immediately.
  scheduler.setDeclaredLimit('local', 1);
  assert.equal(snapshotLimit(scheduler), 1);
  // Emptying the running set admits exactly one held acquire under the new bound.
  releases[0]();
  releases[1]();
  const third = await releases[2];
  assert.equal(scheduler.snapshot()[0].running, 1);
  // Releasing again admits the last held acquire; draining ends at zero.
  third();
  const fourth = await releases[3];
  fourth();
  await Promise.allSettled(releases);
  assert.equal(scheduler.snapshot()[0].running, 0);
});

function snapshotLimit(scheduler) {
  return scheduler.snapshot()[0].limit;
}

test('a declared ceiling applies to a route the operator has never seen run', async () => {
  const scheduler = new FairScheduler({ limit: 4 });
  scheduler.setDeclaredLimit('fresh', 3);
  assert.equal(scheduler.snapshot().length, 1, 'declaring a route must not create phantom running state');
  assert.equal(scheduler.snapshot()[0].running, 0);
  assert.equal(scheduler.snapshot()[0].declaredLimit, 3);
  assert.equal(scheduler.snapshot()[0].limit, 3);
});
