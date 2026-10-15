// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDirectoryPicker } from './directory-picker.mjs';

function fixture() {
  const window = new EventEmitter(), contents = new EventEmitter();
  let choose, fail, count = 0;
  const pick = createDirectoryPicker({ showOpenDialog: () => {
    count += 1; return new Promise((resolve, reject) => { choose = resolve; fail = reject; });
  } });
  return { window, contents, pick, count: () => count,
    choose: value => choose(value), fail: value => fail(value) };
}

test('concurrent folder requests share one native dialog and its selection', async () => {
  const f = fixture(), first = f.pick(f.window, f.contents), second = f.pick(f.window, f.contents);
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(f.count(), 1);
  f.choose({ canceled: false, filePaths: ['D:\\work'] });
  assert.deepEqual(await first, { ok: true, result: 'D:\\work' });
  assert.equal(f.window.listenerCount('closed'), 0);
  const again = f.pick(f.window, f.contents); await Promise.resolve();
  assert.equal(f.count(), 2); f.choose({ canceled: true, filePaths: [] });
  assert.deepEqual(await again, { ok: true, result: null });
});

test('closing the owner settles pending selection and ignores a late dialog result', async () => {
  for (const event of ['closed', 'destroyed', 'render-process-gone', 'did-start-navigation']) {
    const f = fixture(), result = f.pick(f.window, f.contents); await Promise.resolve();
    (event === 'closed' ? f.window : f.contents).emit(event);
    assert.deepEqual(await result, { ok: true, result: null });
    assert.equal((await f.pick(f.window, f.contents)).error, 'directory-picker-already-open');
    f.choose({ canceled: false, filePaths: ['D:\\late'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.contents.listenerCount('destroyed'), 0);
  }
});

test('subframe navigation leaves selection pending; dialog errors permit retry', async () => {
  const f = fixture(), result = f.pick(f.window, f.contents); await Promise.resolve();
  f.contents.emit('did-start-navigation', {}, 'https://child.invalid', false, false);
  f.fail(new Error('dialog failed'));
  assert.deepEqual(await result, { ok: false, error: 'dialog failed' });
  const again = f.pick(f.window, f.contents); await Promise.resolve();
  assert.equal(f.count(), 2); f.choose({ canceled: true }); await again;
});
