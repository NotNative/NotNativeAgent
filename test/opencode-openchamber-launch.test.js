// SPDX-License-Identifier: Apache-2.0
// The OpenChamber binding is described, never persisted and never acted on.
// `enable` installs a login script that runs `opencode start`, so a launch
// there would open the GUI at every sign-in; the operator launches OpenChamber
// themselves. Nothing is written to the user profile, so nothing stale survives
// a reboot or logoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openchamberEnvironment, resolveOpenchamberLauncher } from '../src/opencode/openchamber.js';
import { generateOpencodePassword, loadOpenCodeConfig, normalizeOpenCodeConfig, saveOpenCodeConfig } from '../src/opencode/config.js';
import { startOpencodeService, stopOpencodeService, disableOpencodeService } from '../src/opencode/service.js';

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
  // The builder itself still carries a non-default username it is handed.
  const handBuilt = openchamberEnvironment({ username: 'operator', password: 'x' }, 'http://127.0.0.1:4095');
  assert.equal(handBuilt.OPENCODE_SERVER_USERNAME, 'operator');
});

test('a stored custom username never blocks a lifecycle command', async () => {
  // Why: enable, disable and start carry the existing document forward. They are
  // not choosing a username, so a legacy value must not block them — a service
  // an operator cannot stop is worse than one they cannot start.
  const paths = await servicePaths();
  const password = generateOpencodePassword();
  await mkdir(join(paths.root, 'config'), { recursive: true });
  await writeFile(paths.opencodeConfig, JSON.stringify({ version: 1, enabled: true,
    hostname: '127.0.0.1', port: 4095, username: 'operator', password }));
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3211),
    startupFolder: async () => paths.root, fileRemove: async () => undefined, fileWriter: async () => undefined,
    userEnvironmentRead: async (names) => Object.fromEntries(names.map((name) => [name, ''])),
    userEnvironmentWrite: async () => undefined, kill: () => undefined, environment: {} };
  // disable always rewrites the document, so it exercises the lifecycle write
  // that used to be blocked by a stored username.
  const disabled = await disableOpencodeService({}, paths, scope);
  assert.equal(disabled.config.autostart_enabled, false);
  // The stored username is carried forward untouched rather than rewritten.
  const stored = JSON.parse(await readFile(paths.opencodeConfig, 'utf8'));
  assert.equal(stored.username, 'operator');
});

test('a custom username is refused when chosen but never strands a stored config', async () => {
  // Compatibility: OpenChamber authenticates as `opencode` and ignores the
  // override, so a custom username is an authentication it can never satisfy.
  // Why not at load time: a document written by an earlier build must stay
  // readable and repairable. Refusing it on load broke status, start, stop and
  // the settings page on a config the operator could no longer fix.
  const root = await mkdtemp(join(tmpdir(), 'nna-username-'));
  const path = join(root, 'opencode.json');
  const password = generateOpencodePassword();
  try {
    await writeFile(path, JSON.stringify({ version: 1, enabled: true, hostname: '127.0.0.1',
      port: 4095, username: 'operator', password }));
    // A legacy document still loads, so every lifecycle command still works.
    const legacy = await loadOpenCodeConfig(path);
    assert.equal(legacy.username, 'operator');
    // Choosing it again is refused with a specific code.
    await assert.rejects(() => saveOpenCodeConfig(path, { ...legacy }), { code: 'opencode_username_unsupported' });
    // And the operator can repair it to the username the client sends.
    const repaired = await saveOpenCodeConfig(path, { ...legacy, username: 'opencode' });
    assert.equal(repaired.username, 'opencode');
    assert.equal((await loadOpenCodeConfig(path)).username, 'opencode');
  } finally { await rm(root, { recursive: true, force: true }); }
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
  // the GUI. It does apply the user-scope binding the client reads at launch.
  assert.deepEqual(started.openchamber, { launched: false, reason: 'manual_launch_required' });
  assert.equal(recorder.launches.length, 0);
  assert.deepEqual(started.environment, { OPENCODE_SKIP_START: 'true',
    OPENCODE_HOST: 'http://127.0.0.1:4095',
    OPENCODE_SERVER_PASSWORD: (await loadOpenCodeConfig(paths.opencodeConfig)).password });
  assert.deepEqual(environmentWrites, [{ OPENCODE_SKIP_START: 'true',
    OPENCODE_HOST: 'http://127.0.0.1:4095',
    OPENCODE_SERVER_PASSWORD: (await loadOpenCodeConfig(paths.opencodeConfig)).password }]);
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

test('start on an already-running surface launches nothing and re-applies the binding', async () => {
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
  // Why two writes: the second start re-applies the binding, healing a stale
  // one a crashed previous serve process may have left behind.
  assert.equal(environmentWrites.length, 2);
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

test('start applies the binding and stop clears it, so nothing outlives the server', async () => {
  const paths = await servicePaths();
  const persisted = [];
  const recorder = launcherRecorder();
  const launcher = join(paths.root, 'openchamber.cmd');
  await writeFile(launcher, '', 'utf8');
  // The only writer the scope exposes records attempted writes.
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: () => fakeChild(3210),
    openchamberPath: launcher, launchProcess: recorder.launchProcess, environment: {},
    userEnvironmentWrite: async (pairs) => { persisted.push(pairs); } };
  await startOpencodeService({}, paths, scope);
  assert.equal(persisted.length, 1, 'start applies the binding the client reads');
  await stopOpencodeService({}, paths, scope);
  // Invariant: after a full start/stop the user profile holds no OpenCode binding,
  // so nothing outlives the server the operator started by hand.
  assert.equal(persisted.length, 1, 'stop clears rather than writing again');
  assert.equal(recorder.launches.length, 0);
});
