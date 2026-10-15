// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function preload() {
  const exposed = {}, ipc = new EventEmitter(), window = new EventEmitter(), timers = new Map(), sent = [];
  let clock = 0, id = 0;
  window.addEventListener = (name, callback) => window.on(name, callback);
  ipc.send = (channel, envelope) => sent.push({ channel, ...envelope });
  const source = (await readFile(new URL('./preload.mjs', import.meta.url), 'utf8'))
    .replace("import { contextBridge, ipcRenderer } from 'electron';", '');
  vm.runInNewContext(source, { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: ipc, window, process: { arch: 'x64' }, console,
    setTimeout: (callback, delay) => { const key = ++id; timers.set(key, { callback, at: clock + delay }); return key; },
    clearTimeout: key => timers.delete(key),
  });
  return { invoke: exposed.__NOTNATIVE_DESKTOP_INVOKE__, sent, window,
    reply: (seq, result) => ipc.emit('nnd:desktop-reply', {}, { seq, ...result }),
    advance: ms => { clock += ms; for (const [key, timer] of timers) if (timer.at <= clock) { timers.delete(key); timer.callback(); } },
  };
}

test('folder selection has no timer while other desktop requests retain their deadline', async () => {
  const f = await preload(); let settled = false;
  const first = f.invoke('desktop_pick_directory').then(value => { settled = true; return value; });
  const duplicate = f.invoke('desktop_pick_directory');
  const status = f.invoke('desktop_get_boot_info');
  f.advance(24 * 60 * 60_000); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.sent.filter(row => row.command === 'desktop_pick_directory').length, 1);
  assert.equal((await status).error, 'invoke-timeout');
  f.reply(f.sent[0].seq, { ok: true, result: 'D:\\chosen' });
  assert.equal((await first).result, 'D:\\chosen'); assert.equal((await duplicate).result, 'D:\\chosen');
});

test('cancel and window teardown settle selection without leaving a pending bridge request', async () => {
  const f = await preload(), first = f.invoke('desktop_pick_directory');
  f.reply(f.sent[0].seq, { ok: true, result: null }); assert.equal((await first).result, null);
  const second = f.invoke('desktop_pick_directory'); assert.equal(f.sent.length, 2);
  f.window.emit('unload'); assert.equal((await second).error, 'window-closed');
});
