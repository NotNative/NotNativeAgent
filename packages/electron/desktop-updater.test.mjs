// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopUpdater } from './desktop-updater.mjs';

function fixture(overrides = {}) {
  const updater = new EventEmitter();
  Object.assign(updater, { setFeedURL(feed) { this.feed = feed; }, checkForUpdates: async () => ({ updateInfo: { version: '20260930-68', releaseNotes: 'Notes' } }), downloadUpdate: async () => {}, quitAndInstall() { this.installed = true; } });
  const progress = []; const taskbar = [];
  const policy = createDesktopUpdater({ autoUpdater: updater, packaged: true, platform: 'win32', architecture: 'x64', environment: {}, currentVersion: '20260930-67', emitProgress: (x) => progress.push(x), setTaskbarProgress: (x) => taskbar.push(x), graceMs: 5, ...overrides });
  return { policy, updater, progress, taskbar };
}

test('configures updater once, selects production feed, and reports progress', () => {
  const f = fixture();
  assert.equal(f.policy.setup(), true);
  assert.equal(f.policy.setup(), false);
  assert.equal(f.updater.autoDownload, false);
  assert.deepEqual(f.updater.feed, { provider: 'github', owner: 'openchamber', repo: 'openchamber' });
  f.updater.emit('download-progress', { total: 100, transferred: 40, bytesPerSecond: 12 });
  assert.deepEqual(f.progress[0], { event: 'Progress', data: { chunkLength: 12, downloaded: 40, total: 100 } });
  assert.equal(f.taskbar.at(-1), 0.4);
});

test('checks update version and release notes, then downloads and records completion', async () => {
  const f = fixture(); f.policy.setup();
  assert.deepEqual(await f.policy.check(), { available: true, currentVersion: '20260930-67', version: '20260930-68', body: 'Notes', date: null });
  await f.policy.download();
  assert.deepEqual(f.policy.getPending(), { version: '20260930-68', downloaded: true });
  assert.deepEqual(f.progress.map((event) => event.event), ['Started', 'Finished']);
  await f.policy.install();
  assert.equal(f.updater.installed, true);
});

test('update install returns after the grace window and rolls back when updater reports an error', async () => {
  const changes = [];
  const f = fixture({ graceMs: 20, onInstallStart: () => changes.push('start'), onInstallRollback: () => changes.push('rollback') });
  f.policy.setup();
  await f.policy.check(); await f.policy.download();
  const pending = f.policy.install();
  setImmediate(() => f.updater.emit('error', new Error('signature rejected')));
  await assert.rejects(pending, /signature rejected/u);
  assert.deepEqual(changes, ['start', 'rollback']);
});

test('late installer errors still roll back and leave the install route reusable', async () => {
  const changes = [];
  const f = fixture({ graceMs: 1, onInstallStart: () => changes.push('start'), onInstallRollback: () => changes.push('rollback'), onInstallError: (error) => changes.push(error.message) });
  f.policy.setup();
  await f.policy.check(); await f.policy.download();
  await f.policy.install(); // IPC grace elapsed; updater may still report asynchronously.
  assert.equal(f.updater.listenerCount('error'), 2); // setup progress listener + install listener
  f.updater.emit('error', new Error('installer exited late'));
  assert.deepEqual(changes, ['start', 'rollback', 'Unable to install desktop update: installer exited late']);
  assert.equal(f.updater.listenerCount('error'), 1);
  await f.policy.install(); // retry after rollback is accepted
  assert.equal(f.updater.installed, true);
  f.policy.dispose();
  assert.equal(f.updater.listenerCount('error'), 0);
});

test('macOS update install requires the packaged app to be in Applications', async () => {
  const f = fixture({ platform: 'darwin', isInApplicationsFolder: () => false });
  f.policy.setup();
  await f.policy.check(); await f.policy.download();
  assert.throws(() => f.policy.install(), /installed in \/Applications/u);
});

test('turns absent release manifests into no update, while surfacing network failures', async () => {
  const f = fixture(); f.policy.setup();
  f.updater.checkForUpdates = async () => { throw new Error('HttpError: 404'); };
  assert.equal((await f.policy.check()).available, false);
  f.updater.checkForUpdates = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(f.policy.check(), /Unable to check for updates/u);
});

test('refuses update operations before packaged updater setup', async () => {
  const f = fixture({ packaged: false });
  assert.equal(f.policy.setup(), false);
  await assert.rejects(f.policy.check(), /unavailable in this build/u);
});
