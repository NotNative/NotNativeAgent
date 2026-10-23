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
