// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHostControls } from './native-host-controls.mjs';

async function fixture(t, overrides = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'nna-host-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const plan = { nnaInstallRoot: 'C:/NNA', installationId: 'install', dataId: 'data', incarnationId: 'one' };
  const calls = [], timers = []; let enabled = false;
  const run = createNativeHostControls({ selection: () => ({ installation_id: 'install', data_id: 'data', incarnation_id: 'one' }),
    anchor: () => 'C:/Desktop', openBrowser: async () => {}, beforeRestart: overrides.beforeRestart,
    reconnect: async generation => { calls.push(['reconnect', generation]); } }, {
    resolve: async () => plan, runtime: () => ({ dataRoot, root: 'C:/NNA', node: 'node.exe', cli: 'C:/NNA/cli.js', version: '20261017-1' }),
    execute: async (node, args, options) => {
      calls.push({ node, args, options }); const action = args.at(-1);
      if (action === 'status') return { stdout: JSON.stringify({ enabled, login: { installed: enabled, supported: true },
        service: { installation_id: 'install', data_id: 'data', instance_id: '00000000-0000-4000-8000-000000000000' } }) };
      enabled = action === 'enable'; return { stdout: JSON.stringify({ enabled, login: { installed: enabled } }) };
    }, tray: async (_anchor, action) => { calls.push(action); return { restarted: true, generation: 'new' }; },
    schedule: callback => { timers.push(callback); }, ...overrides,
  });
  return { run, calls, timers, plan };
}

test('host uses native service wiring, persists CAS preferences and schedules reconnection only after restart', async t => {
  const { run, calls, timers } = await fixture(t);
  const before = await run('read'); assert.equal(before.target, 'desktop'); assert.equal(before.enabled, false);
  const saved = await run('preferences', { revision: before.revision, target: 'browser' });
  assert.equal((await run('read')).target, 'browser');
  await assert.rejects(run('preferences', { revision: before.revision, target: 'desktop' }), /conflict/u);
  assert.equal(saved.target, 'browser');
  assert.deepEqual(await run('login', { enabled: true }), { enabled: true, login_installed: true });
  const command = calls.find(call => call.args?.at(-1) === 'enable');
  assert.deepEqual(command.args, ['C:/NNA/cli.js', 'desktop', 'enable']);
  assert.equal(command.options.windowsHide, true); assert.equal(command.options.shell, false);
  assert.ok(command.options.env.NNA_HOME); assert.equal(command.options.env.NODE_OPTIONS, undefined);
  await run('restart'); assert.equal(timers.length, 1); assert.ok(!calls.includes('reconnect'));
  await timers[0](); assert.deepEqual(calls.at(-1), ['reconnect', 'new']);
  await assert.rejects(run('login', { enabled: 'yes' }), /invalid/u);
});

test('foreign selection, unconfirmed wiring and failed restart cannot claim success or reconnect', async t => {
  const foreign = await fixture(t, { resolve: async () => ({ installationId: 'other' }) });
  await assert.rejects(foreign.run('restart'), /identity-changed/u); assert.equal(foreign.calls.length, 0);
  const badLogin = await fixture(t, { execute: async () => ({ stdout: '{"enabled":false,"login":{"installed":false}}' }) });
  await assert.rejects(badLogin.run('login', { enabled: true }), /unconfirmed/u);
  const failed = await fixture(t, { tray: async () => { throw new Error('nnd_owner_unverified'); } });
  await assert.rejects(failed.run('restart'), /unverified/u); assert.equal(failed.timers.length, 0);
  const unsaved = await fixture(t, { beforeRestart: async () => { throw new Error('native-continuity-unavailable'); } });
  await assert.rejects(unsaved.run('restart'), /continuity-unavailable/u);
  assert.equal(unsaved.calls.includes('restart'), false); assert.equal(unsaved.timers.length, 0);
});

test('a concurrent host operation is refused instead of racing startup wiring', async t => {
  let finish; const { run } = await fixture(t, { execute: () => new Promise(resolve => { finish = resolve; }) });
  const pending = run('login', { enabled: true });
  await assert.rejects(run('login', { enabled: false }), /busy/u);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function');
  finish({ stdout: '{"enabled":true,"login":{"installed":true}}' }); await pending;
});

test('read observations neither block a mutation nor release its in-flight guard', async t => {
  let finishRead, finishWrite;
  const { run } = await fixture(t, { execute: (_node, args) => new Promise(resolve => {
    if (args.at(-1) === 'status') finishRead = resolve; else finishWrite = resolve;
  }) });
  const reading = run('read'), writing = run('login', { enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishRead, 'function'); assert.equal(typeof finishWrite, 'function');
  finishRead({ stdout: JSON.stringify({ enabled: false, login: { installed: false, supported: true },
    service: { installation_id: 'install', data_id: 'data', instance_id: '00000000-0000-4000-8000-000000000000' } }) });
  await reading;
  await assert.rejects(run('login', { enabled: false }), /busy/u);
  finishWrite({ stdout: '{"enabled":true,"login":{"installed":true}}' }); await writing;
});
