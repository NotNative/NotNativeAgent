// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { SessionLock } from '../src/persistence/session-lock.js';
import { bindUrl, DEFAULT_OPENCODE_CONFIG, generateOpencodePassword, loadOpenCodeConfig, normalizeOpenCodeConfig, opencodePublicStatus, saveOpenCodeConfig } from '../src/opencode/config.js';
import { observeUserEnvironment } from '../src/opencode/user-environment.js';
import { disableOpencodeService, enableOpencodeService, opencodeRuntimeStatus, opencodeServiceStatus, requireServiceRuntime, startOpencodeService, stopOpencodeService } from '../src/opencode/service.js';

const STARTUP_SCRIPT_NAME = 'NotNativeAgent-OpenCode.vbs';

async function servicePaths() {
  const root = await mkdtemp(join(tmpdir(), 'nna-opencode-service-'));
  const paths = { root, opencodeConfig: join(root, 'config', 'opencode.json'), opencode: join(root, 'runtime', 'opencode'), logs: join(root, 'logs') };
  await mkdir(paths.opencode, { recursive: true }); await mkdir(paths.logs, { recursive: true });
  return paths;
}

function environment(initial = {}) {
  const state = { ...initial }; const writes = [];
  return { state, writes, async write(values) { writes.push(values); Object.assign(state, values); }, async read(names) { return Object.fromEntries(names.map((name) => [name, state[name] ?? ''])); } };
}

function identity() { return { capture: async (pid) => ({ version: 1, pid, platform: 'fixture', start_id: 'fixture' }), compare: async () => 'same', live: () => true }; }
function child(pid = 3210) { const value = new EventEmitter(); value.pid = pid; value.unref = () => undefined; return value; }
function spawn(value) { return () => { queueMicrotask(() => value.emit('spawn')); return value; }; }

test('configuration is durable, redacted, and reports auto-start independently', async () => {
  const paths = await servicePaths();
  assert.deepEqual(await loadOpenCodeConfig(paths.opencodeConfig), DEFAULT_OPENCODE_CONFIG);
  const config = await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  const status = opencodePublicStatus(config, {});
  assert.equal(status.autostart_enabled, true);
  assert.equal(Object.hasOwn(status, 'enabled'), false);
  assert.equal(JSON.stringify(status).includes(config.password), false);
  assert.throws(() => normalizeOpenCodeConfig({ port: 0 }), { code: 'opencode_bind_port_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '0.0.0.0' }), { code: 'opencode_bind_exposed_requires_password' });
});

test('a bind literal cannot pass as a DNS hostname and evade the exposed-bind rule', () => {
  // Security: brackets assert an IPv6 address. A bracketed IPv4 literal used to
  // lose its brackets and reach the hostname pattern, binding the loopback host
  // while reporting an unvalidated name.
  assert.equal(normalizeOpenCodeConfig({ hostname: '[::1]' }).hostname, '::1');
  assert.equal(normalizeOpenCodeConfig({ hostname: '::1' }).hostname, '::1');
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '[127.0.0.1]' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '[0.0.0.0]' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '[not-an-ip]' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '[::1' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '::1]' }), { code: 'opencode_hostname_invalid' });
  // An unbracketed non-loopback literal is still exposed and still needs a password.
  for (const hostname of ['[fe80::1]', '[2001:db8::1]', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.throws(() => normalizeOpenCodeConfig({ hostname }), { code: 'opencode_bind_exposed_requires_password' });
    assert.equal(normalizeOpenCodeConfig({ hostname, password: generateOpencodePassword() }).hostname,
      hostname.replace(/^\[|\]$/gu, ''));
  }
});

test('start provisions a runtime identity without login auto-start', async () => {
  const paths = await servicePaths();
  const result = await startOpencodeService({}, paths, { platform: 'linux', processIdentity: identity(), spawnProcess: spawn(child()) });
  assert.deepEqual(result, { started: true, pid: 3210, port: 4095, url: 'http://127.0.0.1:4095',
    environment: { OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://127.0.0.1:4095',
      OPENCODE_SERVER_PASSWORD: (await loadOpenCodeConfig(paths.opencodeConfig)).password },
    environment_applied: { supported: false },
    openchamber: { launched: false, reason: 'manual_launch_required' } });
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  assert.equal(config.enabled, false);
  assert.match(config.password, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await opencodeRuntimeStatus(paths, { processIdentity: identity() })).running, true);
});

test('start applies the user-scope binding and reports it; stop clears it', async () => {
  const paths = await servicePaths(); const env = environment();
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: spawn(child()),
    userEnvironmentRead: env.read, userEnvironmentWrite: env.write, environment: {} };
  const started = await startOpencodeService({}, paths, scope);
  // Invariant: the agreed lifecycle is start writes, stop clears. OpenChamber
  // reads the user profile at its own launch, so the binding must persist while
  // the server runs and must not outlive it.
  assert.deepEqual(env.writes.map((write) => Object.keys(write).sort()), [
    ['OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SKIP_START'],
  ]);
  assert.equal(started.environment.OPENCODE_HOST, 'http://127.0.0.1:4095');
  assert.deepEqual(started.environment_applied?.written, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD']);
  const observed = await observeUserEnvironment({ platform: 'win32', userEnvironmentRead: env.read });
  assert.equal(observed.host, 'http://127.0.0.1:4095');
  assert.equal(observed.password_present, true);
  // A re-start while running re-applies the binding (a crashed previous serve
  // may have left it stale), so the operator's restart heals the binding.
  const again = await startOpencodeService({}, paths, scope);
  assert.equal(again.reason, 'already_running');
  assert.deepEqual(again.environment_applied?.written, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD']);
  assert.equal(env.writes.length, 2);
});

test('start never launches OpenChamber, because the login script runs it too', async () => {
  const paths = await servicePaths(); const killed = [];
  const started = await startOpencodeService({}, paths, {
    platform: 'win32', processIdentity: identity(), spawnProcess: spawn(child(3222)),
    pathValue: 'C:\\nowhere', appData: 'C:\\also-nowhere', environment: {}, kill: (...args) => killed.push(args),
  });
  assert.equal(started.started, true);
  // Invariant: `enable` runs `opencode start` at sign-in, so a launch here would
  // force the GUI open on every login. The binding stays a description only.
  assert.deepEqual(started.openchamber, { launched: false, reason: 'manual_launch_required' });
  assert.deepEqual(killed, []);
});

test('stop still clears a binding left by an older build while preserving auto-start', async () => {
  const paths = await servicePaths(); const password = generateOpencodePassword(); const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://127.0.0.1:4095', OPENCODE_SERVER_PASSWORD: password });
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password });
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({ version: 2, pid: 44, process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'fixture' } }));
  const result = await stopOpencodeService({}, paths, { platform: 'win32', processIdentity: identity(), kill: () => undefined, userEnvironmentRead: env.read, userEnvironmentWrite: env.write });
  assert.equal(result.stopped, true);
  // Compatibility: a user profile written by an earlier build still clears on
  // stop, so an upgraded installation cannot keep a stale latch.
  assert.deepEqual(Object.keys(env.writes[0]).sort(), ['OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SKIP_START']);
  assert.equal((await loadOpenCodeConfig(paths.opencodeConfig)).enabled, true);
});

test('stop clears the legacy binding that wrote the default username literally', async () => {
  // Why: early wiring (and the manual setup that preceded enable writing
  // anything) recorded `OPENCODE_SERVER_USERNAME=opencode`. A strict-equality
  // check against the current minimal form treated that owned binding as
  // foreign, so stop never removed it and OpenChamber kept pointing at a
  // dead server with skip-start latched.
  const paths = await servicePaths(); const password = generateOpencodePassword();
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://127.0.0.1:4095',
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' });
  await saveOpenCodeConfig(paths.opencodeConfig, { hostname: '127.0.0.1', port: 4095, username: 'opencode', password });
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({ version: 2, pid: 44, process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'fixture' } }));
  const result = await stopOpencodeService({}, paths, { platform: 'win32', processIdentity: identity(), kill: () => undefined, userEnvironmentRead: env.read, userEnvironmentWrite: env.write });
  assert.equal(result.stopped, true);
  assert.deepEqual(env.writes[0], {
    OPENCODE_SKIP_START: null, OPENCODE_HOST: null, OPENCODE_SERVER_PASSWORD: null, OPENCODE_SERVER_USERNAME: null,
  });
  assert.equal(result.environment.preserved, false);
  assert.deepEqual(result.environment.removed, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']);
});

test('stop preserves user environment when it no longer matches this install', async () => {
  const paths = await servicePaths(); const localPassword = generateOpencodePassword();
  const foreignPassword = generateOpencodePassword();
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://192.168.1.8:8000',
    OPENCODE_SERVER_PASSWORD: foreignPassword, OPENCODE_SERVER_USERNAME: 'other-user' });
  await saveOpenCodeConfig(paths.opencodeConfig, { hostname: '127.0.0.1', port: 4095, username: 'opencode', password: localPassword });
  const result = await stopOpencodeService({}, paths, {
    platform: 'win32', userEnvironmentRead: env.read, userEnvironmentWrite: env.write,
  });
  assert.equal(result.stopped, false);
  assert.deepEqual(env.writes, []);
  assert.equal(env.state.OPENCODE_HOST, 'http://192.168.1.8:8000');
  assert.equal(env.state.OPENCODE_SERVER_PASSWORD, foreignPassword);
  assert.equal(result.environment.preserved, true);
  assert.equal(result.environment.reason, 'ownership_unverified');
});

test('stop preserves shared values when config or ownership cannot be verified', async () => {
  const paths = await servicePaths(); const password = generateOpencodePassword();
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://127.0.0.1:4095', OPENCODE_SERVER_PASSWORD: password });
  await saveOpenCodeConfig(paths.opencodeConfig, { password });
  const result = await stopOpencodeService({}, paths, {
    platform: 'win32', userEnvironmentRead: async () => { throw new Error('registry read failed'); },
    userEnvironmentWrite: env.write,
  });
  assert.deepEqual(env.writes, []);
  assert.equal(env.state.OPENCODE_SERVER_PASSWORD, password);
  assert.equal(result.environment.preserved, true);
  await writeFile(paths.opencodeConfig, '{invalid');
  const invalid = await stopOpencodeService({}, paths, { platform: 'win32', userEnvironmentRead: env.read, userEnvironmentWrite: env.write });
  assert.deepEqual(env.writes, []);
  assert.equal(invalid.environment.preserved, true);
});

test('production environment cleanup compares ownership and clears under the shared mutex', async () => {
  const paths = await servicePaths(); const password = generateOpencodePassword(); let script = '';
  await saveOpenCodeConfig(paths.opencodeConfig, { hostname: '127.0.0.1', port: 4095, username: 'opencode', password });
  const result = await stopOpencodeService({}, paths, {
    platform: 'win32',
    powershell: async (value) => { script = value; return 'cleared\n'; },
  });
  assert.equal(result.environment.preserved, false);
  assert.match(script, /NotNativeAgent-OpenCodeEnvironment-/u);
  assert.match(script, /WaitOne\(30000\)/u);
  assert.match(script, /-cnotcontains \$Current/u);
  assert.ok(script.indexOf('$Mutex.WaitOne') < script.indexOf('-cnotcontains'));
  // Why the registry rather than SetEnvironmentVariable: that call broadcasts
  // WM_SETTINGCHANGE per variable and blocks on every top-level window — about
  // 7.4 s each, 29 s for the four a binding names. The registry write costs about
  // 0.2 s, and one bounded broadcast keeps Explorer's cached block honest.
  assert.ok(script.indexOf('-cnotcontains') < script.indexOf('$Key.DeleteValue'));
  assert.match(script, /OpenSubKey\('Environment', \$true\)/u);
  assert.match(script, /SendMessageTimeout/u);
  assert.doesNotMatch(script, /SetEnvironmentVariable\(\$Name, \$null, 'User'\)/u);
  assert.match(script, /catch \[Threading\.AbandonedMutexException\]/u);
  assert.match(script, /\$Mutex\.ReleaseMutex\(\)/u);
});

test('disable proves the bind address inside the privileged script, not in JavaScript', async () => {
  // Why this asserts the generated script: production takes the branch that reads
  // and writes the registry in one PowerShell process, so a proof evaluated in
  // JavaScript never runs there. An earlier version of this fix added the proof
  // to the JavaScript path only; its unit tests passed while a real `disable` kept
  // reporting `ownership_unverified` and left the binding in place.
  const paths = await servicePaths();
  const config = await saveOpenCodeConfig(paths.opencodeConfig,
    { enabled: true, password: generateOpencodePassword() });
  let script = '';
  const disabled = await disableOpencodeService({}, paths, {
    platform: 'win32',
    // Why the stub emulates the script instead of answering a fixed word: a stub
    // that always says `nna_bind_address` passes whether or not the generated
    // script contains the proof. This one only answers that way when the script it
    // received actually carries both conditions, so deleting either one makes the
    // test fail.
    powershell: async (value) => {
      if (value.includes('OPENCODE_')) {
        script = value;
        const evaluatesProof = value.includes("$Skip -eq 'true'")
          && value.includes('$HostValue -ceq') && value.includes(bindUrl(config));
        return evaluatesProof ? 'nna_bind_address\n' : 'preserved\n';
      }
      // The login-removal helper asks PowerShell for the Startup folder; answering
      // with nothing makes it fail closed and masks what this test is checking.
      return `${join(tmpdir(), 'nna-startup-folder')}\n`;
    },
  });
  assert.equal(disabled.environment.preserved, false);
  assert.equal(disabled.environment.proof, 'nna_bind_address');
  // Why these markers: the accepted-values map already names both variables, so
  // matching on the names proves nothing. `$BindProof` and the host comparison are
  // what only the second proof emits — the assertion this replaced passed even
  // with the proof deleted, which is how the JavaScript-only version looked fixed.
  assert.match(script, /\$BindProof/u);
  assert.match(script, /\$HostValue -ceq/u);
  assert.ok(script.includes(bindUrl(config)), 'the script must compare against the configured bind address');
  // And it must still delete through the registry, under the shared mutex.
  assert.match(script, /NotNativeAgent-OpenCodeEnvironment-/u);
  assert.match(script, /DeleteValue/u);
});

test('a multi-line script result is still read as the outcome it reports', async () => {
  // Why: the cleanup script's own broadcast helper prints a word of its own, so the
  // output can hold more than the single token the caller looks for. Comparing the
  // whole trimmed output against one word made a successful delete report
  // `preserved`, which is worse than a wrong status: the operator is told nothing
  // was removed after it was.
  const paths = await servicePaths();
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  const disabled = await disableOpencodeService({}, paths, {
    platform: 'win32',
    powershell: async () => "written\ncleared\n",
  });
  assert.equal(disabled.environment.preserved, false);
  assert.deepEqual(disabled.environment.removed,
    ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']);
});

test('stop does not clear shared environment while the same instance is starting', async () => {
  const paths = await servicePaths(); const password = generateOpencodePassword();
  await saveOpenCodeConfig(paths.opencodeConfig, { password });
  const startLock = new SessionLock(paths.opencode, 'opencode-start');
  await startLock.acquire();
  try {
    let powershellCalled = false;
    const result = await stopOpencodeService({}, paths, {
      platform: 'win32', powershell: async () => { powershellCalled = true; return 'cleared'; },
    });
    assert.deepEqual(result, { stopped: false, reason: 'operation_in_progress',
      environment: { supported: true, written: [], removed: [] } });
    assert.equal(powershellCalled, false);
  } finally {
    await startLock.release();
  }
});

test('runtime-only stop preserves the shared environment for uninstall rollback safety', async () => {
  const paths = await servicePaths(); let powershellCalled = false;
  await saveOpenCodeConfig(paths.opencodeConfig, { password: generateOpencodePassword() });
  const result = await stopOpencodeService({ preserveEnvironment: true }, paths, {
    platform: 'win32', powershell: async () => { powershellCalled = true; return ''; },
  });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'not_running');
  assert.equal(powershellCalled, false);
  assert.equal(Object.hasOwn(result, 'environment'), false);
});

test('POSIX stop retains verified runtime identity until graceful exit is observable', async () => {
  const paths = await servicePaths(); const killed = []; let comparison = 'same';
  const pidPath = join(paths.opencode, 'opencode.pid');
  await writeFile(pidPath, JSON.stringify({ version: 2, pid: 44,
    process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'fixture' } }));
  const scope = { platform: 'linux', processIdentity: { ...identity(), compare: async () => comparison },
    kill: (...args) => killed.push(args) };
  assert.equal((await stopOpencodeService({}, paths, scope)).stopped, true);
  assert.deepEqual(killed, [[44, 'SIGTERM']]);
  assert.equal((await opencodeRuntimeStatus(paths, scope)).running, true);
  assert.equal(JSON.parse(await readFile(pidPath)).pid, 44);
  comparison = 'gone';
  assert.equal((await opencodeRuntimeStatus(paths, scope)).running, false);
});

test('POSIX stop rejects unverifiable ownership without signaling or hiding the runtime', async () => {
  const paths = await servicePaths();
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({ version: 2, pid: 44,
    process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'fixture' } }));
  const scope = { platform: 'linux', processIdentity: { ...identity(), compare: async () => 'unknown' },
    kill: () => assert.fail('unverified process must not be signaled') };
  await assert.rejects(stopOpencodeService({}, paths, scope), { code: 'opencode_identity_unverifiable' });
  assert.equal((await opencodeRuntimeStatus(paths, scope)).running, true);
});

test('enable writes the spawn switch beside the login script, and disable removes it', async () => {
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-')); const env = environment({ OPENCODE_HOST: 'http://127.0.0.1:4095' });
  // Why this shape: the launcher is discovered from the running script's own path,
  // which an install puts at `<root>/installed/src/cli.js` with the launcher at
  // `<root>/bin/nna.cmd`. The fixture mirrors that or the discovery correctly finds
  // nothing — which is what the next test covers.
  const install = await mkdtemp(join(tmpdir(), 'nna-install-'));
  await mkdir(join(install, 'bin'), { recursive: true });
  await mkdir(join(install, 'installed', 'src'), { recursive: true });
  const launcher = join(install, 'bin', 'nna.cmd');
  await writeFile(launcher, '@echo off\n');
  const scope = { platform: 'win32', startupFolder: () => startup, userEnvironmentRead: env.read, userEnvironmentWrite: env.write,
    scriptPath: join(install, 'installed', 'src', 'cli.js') };
  const enabled = await enableOpencodeService({}, paths, scope);
  assert.equal(enabled.config.autostart_enabled, true); assert.equal(enabled.login.installed, true);
  // Why enable writes: under the spawn contract, `enable` is what points the host at
  // NNA instead of its own OpenCode. It is not only a login script any more.
  assert.deepEqual(enabled.spawn.written, ['OPENCODE_BINARY']);
  assert.equal(env.writes.length, 1);
  assert.match(Buffer.from(await readFile(join(startup, STARTUP_SCRIPT_NAME))).toString('utf16le'), /opencode start/u);
  const disabled = await disableOpencodeService({}, paths, scope);
  assert.equal(disabled.config.autostart_enabled, false); assert.equal(disabled.login.installed, false);
  // Why disable clears only the pointer: it returns the host to its own OpenCode and
  // leaves every other name the operator or `start` owns untouched.
  assert.deepEqual(disabled.spawn.removed, ['OPENCODE_BINARY']);
  // Compatibility: it also clears an attach binding it can prove NNA wrote, because
  // a surviving `OPENCODE_SKIP_START` overrides the spawn pointer in the host and
  // pins it to a port nothing may be listening on. Here nothing was written by
  // `start`, so there is nothing to own and nothing is removed.
  assert.deepEqual(disabled.environment.removed, []);
  assert.equal(disabled.environment.preserved, true);
});

test('disable clears an attach binding an earlier start left behind', async () => {
  // Why this is the reachable trap: `enable` then `start` leaves BOTH postures set.
  // OpenChamber treats `OPENCODE_SKIP_START` as authoritative over every spawn path,
  // so the pointer `enable` wrote is ignored and the host attaches to a fixed port.
  // Disabling only the pointer returned the operator to a host that still would not
  // launch its own OpenCode, and hung on a dead port once the service stopped.
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-'));
  const env = environment();
  const install = await mkdtemp(join(tmpdir(), 'nna-install-'));
  await mkdir(join(install, 'bin'), { recursive: true });
  await mkdir(join(install, 'installed', 'src'), { recursive: true });
  await writeFile(join(install, 'bin', 'nna.cmd'), '@echo off\n');
  const scope = { platform: 'win32', startupFolder: () => startup, processIdentity: identity(),
    spawnProcess: spawn(child()), userEnvironmentRead: env.read, userEnvironmentWrite: env.write,
    environment: {}, scriptPath: join(install, 'installed', 'src', 'cli.js') };

  const enabled = await enableOpencodeService({}, paths, scope);
  assert.deepEqual(enabled.spawn.written, ['OPENCODE_BINARY']);
  // `start` writes the attach set beside the pointer it never touches.
  await startOpencodeService({}, paths, scope);
  assert.equal(env.state.OPENCODE_SKIP_START, 'true');
  assert.match(env.state.OPENCODE_HOST ?? '', /^http:\/\/127\.0\.0\.1:4095$/u);

  const disabled = await disableOpencodeService({}, paths, scope);
  assert.deepEqual(disabled.spawn.removed, ['OPENCODE_BINARY']);
  // Both postures are gone, so the host falls back to its own OpenCode.
  assert.equal(env.state.OPENCODE_BINARY ?? null, null);
  assert.equal(env.state.OPENCODE_SKIP_START ?? null, null);
  assert.equal(env.state.OPENCODE_HOST ?? null, null);
  assert.equal(env.state.OPENCODE_SERVER_PASSWORD ?? null, null);
  assert.equal(disabled.environment.preserved, false);
});

test('disable preserves an attach binding NNA cannot prove it wrote', async () => {
  // Security: the ownership proof is what keeps disable from deleting an operator's
  // own hand-written wiring. A value NNA did not write makes the whole set foreign.
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-'));
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://192.168.1.50:9999',
    OPENCODE_SERVER_PASSWORD: 'foreign-operator-secret' });
  const scope = { platform: 'win32', startupFolder: () => startup,
    userEnvironmentRead: env.read, userEnvironmentWrite: env.write, environment: {} };

  const disabled = await disableOpencodeService({}, paths, scope);
  assert.deepEqual(disabled.environment.removed, []);
  assert.equal(disabled.environment.preserved, true);
  assert.equal(disabled.environment.reason, 'ownership_unverified');
  // The foreign values survive untouched.
  assert.equal(env.state.OPENCODE_HOST, 'http://192.168.1.50:9999');
  assert.equal(env.state.OPENCODE_SKIP_START, 'true');
});

test('disable clears a stale binding at NNA own address, which the strict proof cannot', async () => {
  // Why this case matters more than the matching one: an operator who switches
  // between an installed copy and a source checkout, or who lets the credential
  // rotate, ends up with a binding whose password no longer matches. The strict
  // ownership proof cannot clear that, and the leftover binding then wins over
  // the spawn pointer — OpenChamber attaches to a dead port instead of launching
  // its own OpenCode. `disable` is an explicit instruction about the host, so the
  // bind address is enough.
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-'));
  const config = await saveOpenCodeConfig(paths.opencodeConfig,
    { enabled: true, password: generateOpencodePassword() });
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: bindUrl(config),
    OPENCODE_SERVER_PASSWORD: 'a-credential-from-an-older-build' });
  const scope = { platform: 'win32', startupFolder: () => startup,
    userEnvironmentRead: env.read, userEnvironmentWrite: env.write, environment: {} };

  const disabled = await disableOpencodeService({}, paths, scope);
  assert.equal(disabled.environment.preserved, false);
  assert.equal(disabled.environment.proof, 'nna_bind_address');
  assert.equal(env.state.OPENCODE_SKIP_START ?? null, null);
  assert.equal(env.state.OPENCODE_HOST ?? null, null);
});

test('stop keeps the strict proof and preserves a stale binding', async () => {
  // Why stop differs: stopping a runtime says nothing about what the operator
  // wants the host to do next, so it must not delete wiring it cannot account
  // for. Only `disable` carries the operator's instruction to return the host.
  const paths = await servicePaths();
  const config = await saveOpenCodeConfig(paths.opencodeConfig,
    { enabled: true, password: generateOpencodePassword() });
  const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: bindUrl(config),
    OPENCODE_SERVER_PASSWORD: 'a-credential-from-an-older-build' });
  const scope = { platform: 'win32', processIdentity: identity(), kill: () => undefined,
    userEnvironmentRead: env.read, userEnvironmentWrite: env.write, environment: {} };

  const stopped = await stopOpencodeService({}, paths, scope);
  assert.equal(stopped.environment.preserved, true);
  assert.equal(env.state.OPENCODE_SKIP_START, 'true');
});

test('enable still installs the login script when no launcher exists', async () => {
  // Why: a source checkout has no launcher beside it. The login wiring is still
  // meaningful, so enable reports the missing switch instead of failing outright —
  // otherwise a developer could not exercise enable at all.
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-')); const env = environment();
  const scope = { platform: 'win32', startupFolder: () => startup, userEnvironmentRead: env.read, userEnvironmentWrite: env.write,
    scriptPath: join(startup, 'nowhere', 'src', 'cli.js') };
  const enabled = await enableOpencodeService({}, paths, scope);
  assert.equal(enabled.login.installed, true);
  assert.equal(enabled.spawn.supported, false);
  assert.equal(enabled.spawn.reason, 'launcher_unavailable');
  assert.equal(env.writes.length, 0);
});

test('status reports auto-start, runtime, and environment independently', async () => {
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-')); const env = environment();
  const scope = { platform: 'win32', startupFolder: () => startup, userEnvironmentRead: env.read, userEnvironmentWrite: env.write };
  await enableOpencodeService({}, paths, scope);
  const status = await opencodeServiceStatus({}, paths, scope);
  assert.equal(status.service.autostart_enabled, true); assert.equal(status.runtime.running, false); assert.equal(status.login.installed, true); assert.equal(status.environment.host, null);
  await disableOpencodeService({}, paths, scope);
  assert.equal((await opencodeServiceStatus({}, paths, scope)).service.autostart_enabled, false);
});

test('login wiring stays Windows-only and runtime readiness requires credentials', async () => {
  const paths = await servicePaths();
  await assert.rejects(enableOpencodeService({}, paths, { platform: 'linux' }), { code: 'opencode_login_wiring_unsupported' });
  await assert.rejects(disableOpencodeService({}, paths, { platform: 'linux' }), { code: 'opencode_login_wiring_unsupported' });
  assert.throws(() => requireServiceRuntime(normalizeOpenCodeConfig({ enabled: false })), { code: 'opencode_service_unauthenticated' });
  requireServiceRuntime(normalizeOpenCodeConfig({ enabled: false, password: generateOpencodePassword() }));
});
