// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNndActivationChild } from '../src/nnd-activation-child-observer.js';

const child = Object.freeze({ version: 1, platform: 'win32', pid: 4321, start_id: '123456789' });
const observe = (responses, recorded = child, signal) => {
  const calls = [];
  const probe = async (pid, passedSignal) => {
    calls.push({ pid, signal: passedSignal });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  return { result: observeNndActivationChild(recorded, { probe, signal }), calls };
};

test('matching Windows PID and start identity remains a live child', async () => {
  const { result, calls } = observe([{ state: 'present', start_id: child.start_id }]);
  assert.deepEqual(await result, { state: 'same_process' });
  assert.deepEqual(calls, [{ pid: child.pid, signal: undefined }]);
});

test('successful absence or a reused PID proves the recorded child is gone', async () => {
  assert.deepEqual(await observe([{ state: 'absent' }]).result, { state: 'old_process_gone' });
  assert.deepEqual(await observe([{ state: 'present', start_id: '123456790' }]).result,
    { state: 'old_process_gone' });
});

test('exit or PID reuse between native queries gets at most one fresh observation', async () => {
  const racedExit = observe([{ state: 'retry' }, { state: 'absent' }]);
  assert.deepEqual(await racedExit.result, { state: 'old_process_gone' });
  assert.equal(racedExit.calls.length, 2);
  const racedReuse = observe([{ state: 'retry' }, { state: 'present', start_id: '123456790' }]);
  assert.deepEqual(await racedReuse.result, { state: 'old_process_gone' });
  assert.equal(racedReuse.calls.length, 2);
  const unstable = observe([{ state: 'retry' }, { state: 'retry' }, { state: 'absent' }]);
  assert.deepEqual(await unstable.result, { state: 'unknown' });
  assert.equal(unstable.calls.length, 2);
});

test('query errors and malformed native responses preserve uncertainty', async () => {
  for (const response of [new Error('CIM unavailable'), { state: 'unknown' }, { state: 'present' },
    { state: 'absent', start_id: '123456789' }, { state: 'present', start_id: 'invalid' },
    { state: 'absent', extra: true }, null]) {
    assert.deepEqual(await observe([response]).result, { state: 'unknown' });
  }
});

test('invalid recorded identities and cancellation never issue a native query', async () => {
  for (const recorded of [{ ...child, pid: 0 }, { ...child, pid: 2147483648 },
    { ...child, start_id: '0' }, { ...child, start_id: '123abc' },
    { ...child, platform: 'linux' }, { ...child, extra: true }]) {
    const observation = observe([{ state: 'absent' }], recorded);
    assert.deepEqual(await observation.result, { state: 'unknown' });
    assert.equal(observation.calls.length, 0);
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = observe([{ state: 'absent' }], child, controller.signal);
  assert.deepEqual(await cancelled.result, { state: 'unknown' });
  assert.equal(cancelled.calls.length, 0);
});

test('cancellation during a native probe cannot turn absence into proof', async () => {
  const controller = new AbortController();
  const result = await observeNndActivationChild(child, { signal: controller.signal, probe: async () => {
    controller.abort();
    return { state: 'absent' };
  } });
  assert.deepEqual(result, { state: 'unknown' });
});
