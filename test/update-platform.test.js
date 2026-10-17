// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeUpdatePlatform, verifyUpdatePlatform, verifyDesktopUpdateSource } from '../src/update-platform.js';

const marker = { install_root: join(tmpdir(), 'NNA'), data_root: join(tmpdir(), 'NNA-data'), node: process.execPath };
const desktopRoot = join(tmpdir(), 'Desktop');
function status(running, version = '20260101-2', generation = 'replacement') {
  return { root: desktopRoot, version, running, enabled: false, login: { installed: false },
    ...(running ? { service: { instance_id: generation, service_state: 'ready', package_version: version } } : {}) };
}
function runner(after, registration = { registered: true, valid: true, root: desktopRoot, version: '20260101-2' }) {
  return async (_node, args, options) => {
    assert.equal(options.env.NNA_HOME, marker.data_root);
    return { code: 0, stdout: JSON.stringify(args.includes('package') ? registration : after) };
  };
}
for (const running of [false, true]) test(`platform verifies both packages and preserves ${running ? 'running' : 'stopped'} with login disabled`, async () => {
  const before = status(running, '20260101-1', 'previous');
  const after = status(running);
  assert.deepEqual(await verifyUpdatePlatform(marker, '20260101-2', before, runner(after), 'win32'), after);
});
for (const change of ['version', 'running', 'enabled', 'login', 'generation', 'root', 'registration', 'readiness', 'worker-package']) {
  test(`platform refuses an unconfirmed ${change} after installer success`, async () => {
    const before = status(true, '20260101-1', 'previous'), after = status(true);
    if (change === 'readiness') after.service.service_state = 'degraded';
    if (change === 'worker-package') after.service.package_version = '20260101-1';
    if (change === 'version') after.version = '20260101-1';
    if (change === 'running') after.running = false;
    if (change === 'enabled') after.enabled = true;
    if (change === 'login') after.login.installed = true;
    if (change === 'generation') after.service.instance_id = 'previous';
    if (change === 'root') after.root = join(tmpdir(), 'foreign');
    await assert.rejects(verifyUpdatePlatform(marker, '20260101-2', before,
      runner(after, change === 'registration' ? { registered: false } : undefined), 'win32'), { code: 'update_platform_unverified' });
  });
}
test('unknown desktop state refuses before installation; absent desktop and POSIX remain optional', async () => {
  await assert.rejects(observeUpdatePlatform(marker, runner({}), 'win32'), { code: 'update_platform_unverified' });
  await assert.rejects(observeUpdatePlatform(marker, async () => ({ code: 0, stdout: '{broken' }), 'win32'), { code: 'update_platform_unverified' });
  assert.equal(await verifyUpdatePlatform(marker, '20260101-2', null, runner(null), 'win32'), null);
  assert.equal(await observeUpdatePlatform(marker, () => assert.fail('POSIX queried Windows'), 'linux'), null);
});
test('registered desktop requires matching downloaded desktop bytes before installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-update-desktop-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(verifyDesktopUpdateSource(root, '20260101-2', status(false)), { code: 'update_desktop_source_invalid' });
  await mkdir(join(root, 'desktop'));
  await writeFile(join(root, 'desktop', 'VERSION'), '20260101-2');
  await writeFile(join(root, 'desktop', 'install.cmd'), '@echo off');
  await writeFile(join(root, 'desktop', 'package.json'), JSON.stringify({ nnd_version: '20260101-1' }));
  await assert.rejects(verifyDesktopUpdateSource(root, '20260101-2', status(false)), { code: 'update_desktop_source_invalid' });
  await writeFile(join(root, 'desktop', 'package.json'), JSON.stringify({ nnd_version: '20260101-2' }));
  await verifyDesktopUpdateSource(root, '20260101-2', status(false));
  assert.equal(await readFile(join(root, 'desktop', 'VERSION'), 'utf8'), '20260101-2');
});

test('provider setup requirements do not make a usable updated service fail installation', async () => {
  const after = status(true); after.service.service_state = 'setup_required';
  assert.equal((await verifyUpdatePlatform(marker, '20260101-2', status(true, '20260101-1', 'previous'), runner(after), 'win32')).service.service_state, 'setup_required');
});
