// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import {
  bindUrl, DEFAULT_OPENCODE_CONFIG, generateOpencodePassword, loadOpenCodeConfig, normalizeOpenCodeConfig,
  opencodePublicStatus, saveOpenCodeConfig,
} from '../src/opencode/config.js';
import {
  disableOpencodeService, enableOpencodeService, opencodeRuntimeStatus, opencodeServiceStatus,
  requireServiceRuntime, startOpencodeService, stopOpencodeService,
} from '../src/opencode/service.js';

const STARTUP_SCRIPT_NAME = 'NotNativeAgent-OpenCode.vbs';
const EXPECTED_ENVIRONMENT_NAMES = [
  'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME',
];

async function servicePaths() {
  const root = await mkdtemp(join(tmpdir(), 'nna-opencode-service-'));
  const paths = {
    root,
    opencodeConfig: join(root, 'config', 'opencode.json'),
    opencode: join(root, 'runtime', 'opencode'),
    logs: join(root, 'logs'),
  };
  await mkdir(paths.opencode, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  return paths;
}

function windowsScope(extra = {}) {
  return { platform: 'win32', ...extra };
}

function memoryEnvironment(initial = {}) {
  const state = { ...initial };
  const writes = [];
  return {
    state, writes,
    async write(removals) { writes.push(removals); Object.assign(state, removals); },
    async read(names) { return Object.fromEntries(names.map((name) => [name, state[name] ?? ''])); },
  };
}

async function readStartupScript(startupFolder) {
  const bytes = await readFile(join(startupFolder, STARTUP_SCRIPT_NAME));
  return Buffer.from(bytes).toString('utf16le');
}

// --- configuration -----------------------------------------------------------

test('opencode service config is absent-safe, bounded, durable, and redacted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-opencode-config-'));
  const path = join(root, 'config', 'opencode.json');
  assert.deepEqual(await loadOpenCodeConfig(path), DEFAULT_OPENCODE_CONFIG);
  const config = await saveOpenCodeConfig(path, { enabled: true, password: generateOpencodePassword() });
  assert.equal(config.port, 4095);
  assert.equal(config.username, 'opencode');
  const stored = await readFile(path, 'utf8');
  assert.match(stored, /"password"/u);
  const publicStatus = opencodePublicStatus(config, {});
  assert.equal(publicStatus.configured, true);
  assert.equal(publicStatus.password_source, 'restricted local config');
  assert.equal(JSON.stringify(publicStatus).includes(config.password), false);
  assert.equal(Object.hasOwn(publicStatus, 'password'), false);
  const environmentFallback = opencodePublicStatus(normalizeOpenCodeConfig({ password: null }), { OPENCODE_SERVER_PASSWORD: '2345678901234567890abc' });
  assert.equal(environmentFallback.configured, true);
  assert.equal(environmentFallback.password_source, 'environment');
});

test('opencode service config rejects wire identities outside its bounds', async () => {
  assert.throws(() => normalizeOpenCodeConfig({ port: 0 }), { code: 'opencode_bind_port_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ port: 70_000 }), { code: 'opencode_bind_port_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: 'http://x' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: 'bad host' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ username: 'o:p' }), { code: 'opencode_username_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ password: 'short' }), { code: 'opencode_password_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ updated_at: 'yesterday' }), { code: 'opencode_config_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '0.0.0.0' }), { code: 'opencode_bind_exposed_requires_password' });
  assert.equal(normalizeOpenCodeConfig({ hostname: '0.0.0.0', password: generateOpencodePassword() }).port, 4095);
  assert.throws(() => normalizeOpenCodeConfig({ port: '4095' }), { code: 'opencode_bind_port_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: 'aaa:bbb' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '[::1' }), { code: 'opencode_hostname_invalid' });
  assert.throws(() => normalizeOpenCodeConfig({ hostname: '127.0.0.1:4095' }), { code: 'opencode_hostname_invalid' });
  assert.equal(normalizeOpenCodeConfig({ hostname: '[::1]' }).hostname, '::1');
  assert.equal(normalizeOpenCodeConfig({ hostname: ' 127.0.0.1 ' }).hostname, '127.0.0.1');
  assert.throws(() => normalizeOpenCodeConfig({ version: 2, enabled: true }), { code: 'opencode_config_version_unsupported' });
  assert.throws(() => normalizeOpenCodeConfig({ version: '1' }), { code: 'opencode_config_version_unsupported' });
  assert.equal(normalizeOpenCodeConfig({ version: 1, enabled: true }).version, 1);
});

test('generated opencode passwords are bounded base64url material', () => {
  const seen = new Set();
  for (let index = 0; index < 64; index += 1) {
    const password = generateOpencodePassword();
    assert.match(password, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(seen.has(password), true);
    seen.add(password);
  }
  assert.equal(seen.size, 64);
});

test('opencode bind urls bracket IPv6 hostnames and carry the configured port', () => {
  assert.equal(bindUrl({ hostname: '127.0.0.1', port: 4095 }), 'http://127.0.0.1:4095');
  assert.equal(bindUrl({ hostname: '::1', port: 4096 }), 'http://[::1]:4096');
  assert.equal(bindUrl({ hostname: '[::1]', port: 4096 }), 'http://[::1]:4096');
  assert.equal(bindUrl({ hostname: 'agent.internal.example', port: 4939 }), 'http://agent.internal.example:4939');
});

// --- detached runtime lifecycle ---------------------------------------------

test('opencode runtime status and stop require the recorded process instance', async () => {
  const paths = await servicePaths();
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({
    version: 2, pid: 44, port: 4095, url: 'http://127.0.0.1:4095',
    process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'original' },
  }));
  const different = { compare: async () => 'different', live: () => true };
  assert.deepEqual(await opencodeRuntimeStatus(paths, { processIdentity: different }), {
    running: false, stale: true, pid: 44, reason: 'different',
  });
  const killed = [];
  const same = { compare: async () => 'same', live: () => true };
  assert.deepEqual(await opencodeRuntimeStatus(paths, { processIdentity: same }), {
    running: true, verified: true, pid: 44, port: 4095, url: 'http://127.0.0.1:4095',
  });
  assert.deepEqual(await stopOpencodeService({}, paths, { processIdentity: same, kill: (...args) => killed.push(args) }), {
    stopped: true, pid: 44,
  });
  assert.deepEqual(killed, [[44, 'SIGTERM']]);
  // Why: the stopper removes the pid record it verified; on Windows the child
  // is terminated abruptly and never removes it itself.
  await assert.rejects(readFile(join(paths.opencode, 'opencode.pid')), { code: 'ENOENT' });
  // Why: a pid record NNA cannot parse is unverifiable evidence; the status
  // degrades to stale and stop stays a no-op rather than signaling blindly.
  await writeFile(join(paths.opencode, 'opencode.pid'), '44\n');
  assert.deepEqual(await opencodeRuntimeStatus(paths, { processIdentity: same }), { running: false, stale: true });
  assert.deepEqual(await stopOpencodeService({}, paths, { processIdentity: same, kill: () => assert.fail('must not kill') }), {
    stopped: false, reason: 'not_running',
  });
});

test('opencode start publishes a verified pid only after a valid spawn', async () => {
  const paths = await servicePaths();
  await mkdir(paths.logs, { recursive: true });
  const config = await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  assert.equal(Object.isFrozen(normalizeOpenCodeConfig(config)), true);
  requireServiceRuntime(config);

  const spawnCalls = [];
  const child = new EventEmitter();
  child.pid = 3210;
  child.unref = () => undefined;
  const identity = {
    capture: async (pid) => ({ version: 1, pid, platform: 'fixture', start_id: 'detached' }),
    compare: async () => 'same',
    live: () => true,
  };
  const spawned = startOpencodeService({}, paths, {
    processIdentity: identity,
    spawnProcess: (executable, args, options) => {
      spawnCalls.push({ executable, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(await spawned, { started: true, pid: 3210, port: 4095, url: 'http://127.0.0.1:4095' });
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['opencode', 'run']);
  assert.equal(spawnCalls[0].options.env.NNA_HOME, paths.root);
  const record = JSON.parse(await readFile(join(paths.opencode, 'opencode.pid'), 'utf8'));
  assert.equal(record.pid, 3210);
  assert.equal(record.port, 4095);
  assert.equal(record.url, 'http://127.0.0.1:4095');
  assert.equal(record.version, 2);
  assert.equal(record.process_identity.start_id, 'detached');
  const second = await startOpencodeService({}, paths, { processIdentity: identity });
  assert.deepEqual(second, { started: false, reason: 'already_running', runtime: { running: true, verified: true, pid: 3210, port: 4095, url: 'http://127.0.0.1:4095' } });
});

test('opencode stop tolerates the verified instance exiting mid-stop', async () => {
  const paths = await servicePaths();
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({
    version: 2, pid: 55, port: 4095, url: 'http://127.0.0.1:4095',
    process_identity: { version: 1, pid: 55, platform: 'fixture', start_id: 'same' },
  }));
  const same = { compare: async () => 'same', live: () => true };
  const result = await stopOpencodeService({}, paths, {
    processIdentity: same,
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.deepEqual(result, { stopped: true, pid: 55 });
  await assert.rejects(readFile(join(paths.opencode, 'opencode.pid')), { code: 'ENOENT' });
});

test('opencode start distinguishes a child that exits before identity capture', async () => {
  const paths = await servicePaths();
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  const child = new EventEmitter();
  child.pid = 4321;
  child.unref = () => undefined;
  await assert.rejects(startOpencodeService({}, paths, {
    processIdentity: {
      capture: async () => null,
      compare: async () => 'unknown',
      live: () => false,
    },
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  }), { code: 'opencode_start_failed', message: /exited before its start identity could be recorded/u });
  await assert.rejects(readFile(join(paths.opencode, 'opencode.pid')), { code: 'ENOENT' });
});

test('opencode start fails closed without runtime credentials and reports spawn failure without a pid', async () => {
  const paths = await servicePaths();
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: false, password: generateOpencodePassword() });
  await assert.rejects(startOpencodeService({}, paths, {}), { code: 'opencode_service_disabled' });
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: null });
  await assert.rejects(startOpencodeService({}, paths, {}), { code: 'opencode_service_unauthenticated' });

  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password: generateOpencodePassword() });
  const child = new EventEmitter();
  child.pid = undefined;
  child.unref = () => undefined;
  await assert.rejects(startOpencodeService({}, paths, {
    spawnProcess: () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
      return child;
    },
  }), { code: 'opencode_start_failed' });
  await assert.rejects(readFile(join(paths.opencode, 'opencode.pid')), { code: 'ENOENT' });
});

// --- login and environment wiring -------------------------------------------

test('enable installs the login script, provisions credentials, and writes the OpenChamber environment', async () => {
  const paths = await servicePaths();
  const environment = memoryEnvironment();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-'));
  const result = await enableOpencodeService({}, paths, windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: environment.write,
  }));
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.configured, true);
  // Why: the enable envelope is command output, so the generated credential
  // passes through the shared redaction and never re-enters command output.
  const stored = await loadOpenCodeConfig(paths.opencodeConfig);
  assert.match(stored.password, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(result).includes(stored.password), false);
  assert.deepEqual(result.environment.written, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD']);
  assert.equal(result.login.installed, true);
  const script = await readStartupScript(startupFolder);
  assert.match(script, /NNA_HOME/u);
  assert.match(script, /CreateObject\("WScript\.Shell"\)/u);
  assert.match(script, /opencode start/u);
  assert.match(script, new RegExp(`"${escapeRegExp(paths.root)}"`, 'u'));
  const firstWrite = environment.writes[0];
  assert.equal(firstWrite.OPENCODE_SKIP_START, 'true');
  assert.equal(firstWrite.OPENCODE_HOST, 'http://127.0.0.1:4095');
  assert.equal(firstWrite.OPENCODE_SERVER_PASSWORD, stored.password);
  assert.equal(firstWrite.OPENCODE_SERVER_USERNAME, null);
  assert.equal(result.environment.written.includes('OPENCODE_SERVER_USERNAME'), false);
  assert.deepEqual(result.environment.removed, ['OPENCODE_SERVER_USERNAME']);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('enable is idempotent, honors port and hostname overrides, and keeps an existing password', async () => {
  const paths = await servicePaths();
  const environment = memoryEnvironment();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup2-'));
  const scope = windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: environment.write,
  });
  const first = await enableOpencodeService({}, paths, scope);
  const firstStored = await loadOpenCodeConfig(paths.opencodeConfig);
  const second = await enableOpencodeService({ servePort: 4939, serveHostname: '127.0.0.2' }, paths, scope);
  const secondStored = await loadOpenCodeConfig(paths.opencodeConfig);
  assert.equal(secondStored.password, firstStored.password);
  assert.equal(second.config.port, 4939);
  assert.equal(second.config.hostname, '127.0.0.2');
  assert.equal(second.environment.written.includes('OPENCODE_HOST'), true);
  assert.equal(Object.keys(environment.writes.at(-1)).includes('OPENCODE_SERVER_PASSWORD'), true);
  const third = await enableOpencodeService({ serveHostname: '0.0.0.0' }, paths, scope);
  assert.equal(third.environment.written.includes('OPENCODE_SERVER_USERNAME'), false);
  const thirdStored = await loadOpenCodeConfig(paths.opencodeConfig);
  const customUsername = await saveOpenCodeConfig(paths.opencodeConfig, { ...thirdStored, username: 'nna-operator' });
  const fourth = await enableOpencodeService({}, paths, scope);
  assert.equal(customUsername.username, 'nna-operator');
  assert.deepEqual(fourth.environment.written, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']);
  // Why: reverting to the default username must clear the written name, not
  // leave a stale OpenChamber credential source behind.
  await saveOpenCodeConfig(paths.opencodeConfig, { ...customUsername, username: 'opencode', updated_at: new Date().toISOString() });
  const fifth = await enableOpencodeService({}, paths, scope);
  assert.deepEqual(fifth.environment.removed, ['OPENCODE_SERVER_USERNAME']);
  assert.equal(Object.values(environment.writes.at(-1)).includes('nna-operator'), false);
});

test('disable removes the login script and clears the owned user environment names', async () => {
  const paths = await servicePaths();
  const environment = memoryEnvironment();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup3-'));
  const scope = windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: environment.write,
  });
  await enableOpencodeService({}, paths, scope);
  const result = await disableOpencodeService({}, paths, scope);
  assert.equal(result.config.enabled, false);
  assert.equal(result.login.installed, false);
  assert.equal(result.environment.removed.length, 4);
  await assert.rejects(readFile(join(startupFolder, STARTUP_SCRIPT_NAME)), { code: 'ENOENT' });
  const cleared = environment.writes.at(-1);
  assert.deepEqual(Object.keys(cleared).sort(), [...EXPECTED_ENVIRONMENT_NAMES].sort());
  assert.deepEqual([...Object.values(cleared)], [null, null, null, null]);
});

test('enable rolls the login script back and clears the user environment when it cannot be written', async () => {
  const paths = await servicePaths();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup4-'));
  const attempts = [];
  await assert.rejects(enableOpencodeService({}, paths, windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: async (removals) => {
      attempts.push(removals);
      if (attempts.length === 1) throw new Error('powershell denied');
    },
  })), { code: 'opencode_user_environment_failed' });
  await assert.rejects(readFile(join(startupFolder, STARTUP_SCRIPT_NAME)), { code: 'ENOENT' });
  // Why: a partially applied user-scope wiring set must not linger behind a
  // failed enable; the rollback clears the owned names best-effort.
  assert.deepEqual(attempts[1], {
    OPENCODE_SKIP_START: null, OPENCODE_HOST: null, OPENCODE_SERVER_PASSWORD: null, OPENCODE_SERVER_USERNAME: null,
  });
  // Why: the configuration keeps the operator's enabled intent so a re-run of
  // enable after fixing the environment completes the wiring idempotently.
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  assert.equal(config.enabled, true);
  assert.match(config.password, /^[A-Za-z0-9_-]{43}$/u);
});

test('status reports the wiring truthfully and never leaks the managed password', async () => {
  const paths = await servicePaths();
  const environment = memoryEnvironment();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup5-'));
  const scope = windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: environment.write,
    userEnvironmentRead: environment.read,
  });
  await enableOpencodeService({}, paths, scope);
  const status = await opencodeServiceStatus({}, paths, scope);
  assert.equal(status.service.enabled, true);
  assert.equal(status.service.configured, true);
  assert.equal(status.service.password_source, 'restricted local config');
  assert.equal(status.service.bind_url, 'http://127.0.0.1:4095');
  assert.equal(status.login.installed, true);
  assert.equal(status.environment.skip_start, 'true');
  assert.equal(status.environment.host, 'http://127.0.0.1:4095');
  assert.equal(status.environment.password_present, true);
  assert.equal(JSON.stringify(status).includes(environment.state.OPENCODE_SERVER_PASSWORD), false);
  await disableOpencodeService({}, paths, scope);
  const after = await opencodeServiceStatus({}, paths, scope);
  assert.equal(after.service.enabled, false);
  assert.equal(after.login.installed, false);
  assert.equal(after.environment.host, null);
  assert.equal(after.environment.password_present, false);
});

test('status flags a running surface whose binding no longer matches the wiring', async () => {
  const paths = await servicePaths();
  const environment = memoryEnvironment();
  const startupFolder = await mkdtemp(join(tmpdir(), 'nna-opencode-startup6-'));
  const scope = windowsScope({
    startupFolder: () => startupFolder,
    userEnvironmentWrite: environment.write,
    userEnvironmentRead: environment.read,
  });
  await enableOpencodeService({}, paths, scope);
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({
    version: 2, pid: 77, port: 4095, url: 'http://127.0.0.1:4095',
    process_identity: { version: 1, pid: 77, platform: 'fixture', start_id: 'bound' },
  }));
  assert.equal((await opencodeServiceStatus({}, paths, scope)).stale_binding, false);
  // Why: an enable that moves the wire identity cannot rebind a live runtime,
  // and the persisted plus shared wiring then advertises a port nobody serves.
  await enableOpencodeService({ servePort: 4939 }, paths, scope);
  const moved = await opencodeServiceStatus({}, paths, scope);
  assert.equal(moved.service.bind_url, 'http://127.0.0.1:4939');
  assert.equal(moved.runtime.running, true);
  assert.equal(moved.stale_binding, true);
  // Why: disable deliberately leaves the surface serving; the status must mark
  // that state instead of letting a true runtime report bury the divergence.
  await disableOpencodeService({}, paths, scope);
  const disabled = await opencodeServiceStatus({}, paths, scope);
  assert.equal(disabled.service.enabled, false);
  assert.equal(disabled.runtime.running, true);
  assert.equal(disabled.stale_binding, true);
});

test('status degrades gracefully when wiring probes fail', async () => {
  const paths = await servicePaths();
  const scope = windowsScope({
    startupFolder: () => { throw new Error('registry unavailable'); },
    userEnvironmentRead: async () => { throw new Error('registry unavailable'); },
  });
  const status = await opencodeServiceStatus({}, paths, scope);
  assert.equal(status.login.supported, true);
  assert.equal(status.login.installed, null);
  assert.equal(status.login.error, 'opencode_login_wiring_probe_failed');
  assert.equal(status.environment.supported, true);
  assert.equal(status.environment.error, 'opencode_user_environment_probe_failed');
});

test('enable and disable refuse non-Windows login wiring without persisting partial state', async () => {
  const paths = await servicePaths();
  await assert.rejects(enableOpencodeService({}, paths, { platform: 'linux' }), { code: 'opencode_login_wiring_unsupported' });
  await assert.rejects(disableOpencodeService({}, paths, { platform: 'linux' }), { code: 'opencode_login_wiring_unsupported' });
  await assert.rejects(readFile(paths.opencodeConfig), { code: 'ENOENT' });
  const status = await opencodeServiceStatus({}, paths, { platform: 'linux' });
  assert.equal(status.login.supported, false);
  assert.equal(status.environment.supported, false);
});

// --- requireServiceRuntime gate ---------------------------------------------

test('requireServiceRuntime demands enablement and credentials together', () => {
  assert.throws(() => requireServiceRuntime(normalizeOpenCodeConfig({ enabled: false, password: generateOpencodePassword() })), { code: 'opencode_service_disabled' });
  assert.throws(() => requireServiceRuntime(normalizeOpenCodeConfig({ enabled: true })), { code: 'opencode_service_unauthenticated' });
  requireServiceRuntime(normalizeOpenCodeConfig({ enabled: true, password: generateOpencodePassword() }));
});
