// SPDX-License-Identifier: Apache-2.0
/** Focused coverage for the bounded renderer recovery budget (W-02/W-10). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachRendererRecovery } from './renderer-recovery.mjs';

function fakeShell() {
  const gone = [];
  const closed = [];
  let destroyed = false;
  let reloads = 0;
  const contents = {
    isDestroyed: () => destroyed,
    reload: () => { reloads += 1; },
    on: (event, handler) => { if (event === 'render-process-gone') gone.push(handler); },
    removeListener: (event, handler) => {
      const list = event === 'render-process-gone' ? gone : closed;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  const win = {
    isDestroyed: () => destroyed,
    once: (event, handler) => { if (event === 'closed') closed.push(handler); },
    removeListener: (event, handler) => {
      const list = event === 'render-process-gone' ? gone : closed;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    webContents: contents,
  };
  return {
    win,
    count: () => reloads,
    gone: (details) => gone.forEach((handler) => handler({}, details)),
    close: () => { destroyed = true; closed.forEach((handler) => handler()); },
  };
}

test('recovers a crashed renderer with a bounded reload budget inside the window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000;
  t.mock.timers.setTime(clock);
  const shell = fakeShell();
  const logs = [];
  const dispose = attachRendererRecovery(shell.win, { log: (line) => logs.push(line), now: () => clock });
  shell.gone({ reason: 'crashed', exitCode: 11 });
  clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  assert.equal(shell.count(), 1, 'first crash reloads');
  for (const reason of ['oom', 'abnormal-exit']) {
    shell.gone({ reason });
    clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  }
  assert.equal(shell.count(), 3, 'three recoveries inside the window');
  shell.gone({ reason: 'memory-eviction' });
  clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  assert.equal(shell.count(), 3, 'the budget blocks a fourth reload');
  assert.ok(logs.some((line) => line.includes('budget exhausted')));
  dispose();
});

test('old attempts age out of the window and non-recoverable exits never reload', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000;
  t.mock.timers.setTime(clock);
  const shell = fakeShell();
  const logs = [];
  const dispose = attachRendererRecovery(shell.win, { log: (line) => logs.push(line), now: () => clock });
  shell.gone({ reason: 'crashed' });
  clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  assert.equal(shell.count(), 1);
  clock += 70_000; // The first attempt ages out of the 60 s window.
  t.mock.timers.setTime(clock);
  shell.gone({ reason: 'crashed' });
  clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  assert.equal(shell.count(), 2, 'a fresh window allows recovery again');
  shell.gone({ reason: 'clean-exit', exitCode: 0 });
  clock += 100; t.mock.timers.setTime(clock); t.mock.timers.tick(0);
  assert.equal(shell.count(), 2, 'non-recoverable reason does not reload');
  assert.ok(logs.some((line) => line.includes('without recovery')));
  dispose();
});

test('dispose cancels the pending reload and detaches the gone listener', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shell = fakeShell();
  const dispose = attachRendererRecovery(shell.win, { log: () => undefined, now: () => 0 });
  shell.gone({ reason: 'crashed' });
  dispose();
  t.mock.timers.tick(1_000);
  assert.equal(shell.count(), 0, 'pending reload cancelled by dispose');
  shell.gone({ reason: 'crashed' });
  assert.equal(shell.count(), 0, 'gone listener detached');
  dispose();
});
