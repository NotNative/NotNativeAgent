// SPDX-License-Identifier: Apache-2.0
// The OpenChamber binding is described, never persisted and never acted on.
// `enable` installs a login script that runs `opencode start`, so a launch
// there would open the GUI at every sign-in; the operator launches OpenChamber
// themselves. Nothing is written to the user profile, so nothing stale survives
// a reboot or logoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openchamberEnvironment, resolveOpenchamberLauncher } from '../src/opencode/openchamber.js';
import { generateOpencodePassword, loadOpenCodeConfig, normalizeOpenCodeConfig } from '../src/opencode/config.js';
import { startOpencodeService, stopOpencodeService } from '../src/opencode/service.js';

async function servicePaths() {
  const root = await mkdtemp(join(tmpdir(), 'nna-openchamber-launch-'));
  const paths = { root, opencodeConfig: join(root, 'config', 'opencode.json'), opencode: join(root, 'runtime', 'opencode'), logs: join(root, 'logs') };
  await mkdir(paths.opencode, { recursive: true }); await mkdir(paths.logs, { recursive: true });
  return paths;
}

function identity() { return { capture: async (pid) => ({ version: 1, pid, platform: 'fixture', start_id: 'fixture' }), compare: async () => 'same', live: () => true }; }
// Why: the managed server start resolves only after the child reports `spawn`,
// so every double must emit it or the start promise never settles.
function fakeChild(pid = 3210) {
  const value = new EventEmitter(); value.pid = pid; value.unref = () => undefined;
  queueMicrotask(() => value.emit('spawn'));
  return value;
}

/** A launcher double that records the environment each launched child received. */
function launcherRecorder() {
  const launches = [];
  return { launches, launchProcess: (command, args, options) => { launches.push({ command, args, options }); return fakeChild(9001); } };
}

test('the binding carries the password and never the default username', () => {
  const config = normalizeOpenCodeConfig({ hostname: '127.0.0.1', port: 4095, password: generateOpencodePassword() });
  const binding = openchamberEnvironment(config, 'http://127.0.0.1:4095');
  assert.equal(binding.OPENCODE_HOST, 'http://127.0.0.1:4095');
  assert.equal(binding.OPENCODE_SKIP_START, 'true');
  assert.equal(binding.OPENCODE_SERVER_PASSWORD, config.password);
  assert.equal(Object.hasOwn(binding, 'OPENCODE_SERVER_USERNAME'), false);
  // Security: the client authenticates as `opencode` and ignores the override,
  // so any other username is an authentication it could never satisfy. It is
  // refused at configuration time instead of becoming an unexplained 401.
  assert.throws(() => normalizeOpenCodeConfig({ username: 'operator', password: generateOpencodePassword() }),
    { code: 'opencode_username_unsupported' });
  // The builder itself still omits a default username it is handed directly.
  const handBuilt = openchamberEnvironment({ username: 'operator', password: 'x' }, 'http://127.0.0.1:4095');
  assert.equal(handBuilt.OPENCODE_SERVER_USERNAME, 'operator');
});

test('launcher resolution prefers an explicit path, then PATH, then the npm prefix', () => {
  // APPDATA points at the roaming profile root, so the launcher lives under its
  // `npm` directory; the fixture must mirror that layout.
  const present = new Set(['/opt/bin/openchamber', '/home/operator/.appdata/npm/openchamber']);
  const exists = (candidate) => present.has(candidate.replaceAll('\\', '/'));
  assert.equal(resolveOpenchamberLauncher({ platform: 'linux', pathValue: '/opt/bin:/usr/bin',
    fileExists: exists, openchamberPath: '/opt/bin/openchamber' }), '/opt/bin/openchamber');
  assert.equal(resolveOpenchamberLauncher({ platform: 'linux', pathValue: '/usr/bin:/opt/bin', fileExists: exists }),
    '/opt/bin/openchamber');
  assert.equal(resolveOpenchamberLauncher({ platform: 'linux', pathValue: '/usr/bin', appData: '/home/operator/.appdata',
    fileExists: exists }), '/home/operator/.appdata/npm/openchamber');
  assert.equal(resolveOpenchamberLauncher({ platform: 'linux', pathValue: '/usr/bin', appData: '/nowhere',
    fileExists: exists }), null);
  assert.throws(() => resolveOpenchamberLauncher({ platform: 'linux', pathValue: '/usr/bin', fileExists: exists,
    openchamberPath: '/missing/openchamber' }), { code: 'opencode_openchamber_unavailable' });
});

test('start launches no OpenChamber child even when a launcher is resolvable', async () => {
  const paths = await servicePaths();
  const environmentWrites = [];
  const recorder = launcherRecorder();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  const started = await startOpencodeService({}, paths, {
    platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, launchProcess: recorder.launchProcess, environment: { PATH: 'C:\\fixture\\bin' },
    userEnvironmentWrite: async (pairs) => { environmentWrites.push(pairs); },
  });
  assert.equal(started.started, true);
  // Invariant: the login script runs `opencode start`, so start must not open
  // the GUI. The binding is described, never handed to a child.
  assert.deepEqual(started.openchamber, { launched: false, reason: 'manual_launch_required' });
  assert.equal(recorder.launches.length, 0);
  assert.deepEqual(started.environment, { OPENCODE_SKIP_START: 'true',
    OPENCODE_HOST: 'http://127.0.0.1:4095',
    OPENCODE_SERVER_PASSWORD: (await loadOpenCodeConfig(paths.opencodeConfig)).password });
  assert.deepEqual(environmentWrites, []);
});

test('a missing launcher leaves the binding described and the server started', async () => {
  const paths = await servicePaths();
  const started = await startOpencodeService({}, paths, {
    platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    pathValue: 'C:\\nowhere', appData: 'C:\\also-nowhere', environment: {},
  });
  assert.equal(started.started, true);
  assert.deepEqual(started.openchamber, { launched: false, reason: 'manual_launch_required' });
  assert.equal(typeof started.environment.OPENCODE_HOST, 'string');
});

test('a launcher failure cannot affect a start that never launches', async () => {
  const paths = await servicePaths();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  const started = await startOpencodeService({}, paths, {
    platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, environment: {},
    launchProcess: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.equal(started.started, true);
  assert.deepEqual(started.openchamber, { launched: false, reason: 'manual_launch_required' });
});

test('start on an already-running surface also launches nothing and writes nothing', async () => {
  const paths = await servicePaths();
  const environmentWrites = [];
  const recorder = launcherRecorder();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, launchProcess: recorder.launchProcess, environment: {},
    userEnvironmentWrite: async (pairs) => { environmentWrites.push(pairs); } };
  await startOpencodeService({}, paths, scope);
  const again = await startOpencodeService({}, paths, scope);
  assert.equal(again.reason, 'already_running');
  assert.deepEqual(again.openchamber, { launched: false, reason: 'manual_launch_required' });
  assert.equal(recorder.launches.length, 0);
  assert.deepEqual(environmentWrites, []);
});

test('stop clears nothing it did not write, and a foreign user environment stays', async () => {
  const paths = await servicePaths();
  const recorder = launcherRecorder();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  const removed = [];
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, launchProcess: recorder.launchProcess, environment: {}, kill: () => undefined,
    // A leftover binding from an older build that another product has since changed.
    userEnvironmentRead: async (names) => Object.fromEntries(names.map((name) => [name, ''])),
    userEnvironmentWrite: async (pairs) => { removed.push(pairs); } };
  await startOpencodeService({}, paths, scope);
  const stopped = await stopOpencodeService({}, paths, scope);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.environment.preserved, true);
  assert.equal(stopped.environment.reason, 'ownership_unverified');
  assert.deepEqual(removed.slice(1), []);
});

test('start writes no user environment, so a stale binding is never produced', async () => {
  const paths = await servicePaths();
  const persisted = [];
  const recorder = launcherRecorder();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  // The only writer double the scope exposes records attempted writes.
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, launchProcess: recorder.launchProcess, environment: {},
    userEnvironmentWrite: async (pairs) => { persisted.push(pairs); } };
  await startOpencodeService({}, paths, scope);
  await stopOpencodeService({}, paths, scope);
  // Invariant: after a full start/stop the user profile holds no OpenCode binding,
  // so nothing outlives the server the operator started by hand.
  assert.deepEqual(persisted, []);
  assert.equal(recorder.launches.length, 0);
});
