// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { DEFAULT_OPENCODE_CONFIG, generateOpencodePassword, loadOpenCodeConfig, normalizeOpenCodeConfig, opencodePublicStatus, saveOpenCodeConfig } from '../src/opencode/config.js';
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

test('start provisions a runtime identity without login auto-start', async () => {
  const paths = await servicePaths();
  const result = await startOpencodeService({}, paths, { platform: 'linux', processIdentity: identity(), spawnProcess: spawn(child()) });
  assert.deepEqual(result, { started: true, pid: 3210, port: 4095, url: 'http://127.0.0.1:4095', environment: { supported: false } });
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  assert.equal(config.enabled, false);
  assert.match(config.password, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await opencodeRuntimeStatus(paths, { processIdentity: identity() })).running, true);
});

test('start owns environment setup and refreshes an already-running surface', async () => {
  const paths = await servicePaths(); const env = environment();
  const scope = { platform: 'win32', processIdentity: identity(), spawnProcess: spawn(child()), userEnvironmentRead: env.read, userEnvironmentWrite: env.write };
  const started = await startOpencodeService({}, paths, scope);
  assert.deepEqual(started.environment.written, ['OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD']);
  assert.equal(env.state.OPENCODE_HOST, 'http://127.0.0.1:4095');
  const again = await startOpencodeService({}, paths, scope);
  assert.equal(again.reason, 'already_running');
  assert.deepEqual(again.environment.written, []);
});

test('failed environment setup stops the process that start just launched', async () => {
  const paths = await servicePaths(); const killed = [];
  await assert.rejects(startOpencodeService({}, paths, {
    platform: 'win32', processIdentity: identity(), spawnProcess: spawn(child(3222)),
    userEnvironmentRead: async () => null, userEnvironmentWrite: async () => { throw new Error('registry denied'); },
    kill: (...args) => killed.push(args),
  }), { code: 'opencode_user_environment_failed' });
  assert.deepEqual(killed, [[3222, 'SIGTERM']]);
  await assert.rejects(readFile(join(paths.opencode, 'opencode.pid')), { code: 'ENOENT' });
});

test('stop clears environment while preserving auto-start configuration', async () => {
  const paths = await servicePaths(); const password = generateOpencodePassword(); const env = environment({ OPENCODE_SKIP_START: 'true', OPENCODE_HOST: 'http://127.0.0.1:4095', OPENCODE_SERVER_PASSWORD: password });
  await saveOpenCodeConfig(paths.opencodeConfig, { enabled: true, password });
  await writeFile(join(paths.opencode, 'opencode.pid'), JSON.stringify({ version: 2, pid: 44, process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'fixture' } }));
  const result = await stopOpencodeService({}, paths, { platform: 'win32', processIdentity: identity(), kill: () => undefined, userEnvironmentRead: env.read, userEnvironmentWrite: env.write });
  assert.equal(result.stopped, true);
  assert.deepEqual(Object.keys(env.writes[0]).sort(), ['OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SKIP_START']);
  assert.equal((await loadOpenCodeConfig(paths.opencodeConfig)).enabled, true);
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

test('enable and disable own only the login startup script', async () => {
  const paths = await servicePaths(); const startup = await mkdtemp(join(tmpdir(), 'nna-opencode-startup-')); const env = environment({ OPENCODE_HOST: 'http://127.0.0.1:4095' });
  const scope = { platform: 'win32', startupFolder: () => startup, userEnvironmentRead: env.read, userEnvironmentWrite: env.write };
  const enabled = await enableOpencodeService({}, paths, scope);
  assert.equal(enabled.config.autostart_enabled, true); assert.equal(enabled.login.installed, true); assert.equal(env.writes.length, 0);
  assert.match(Buffer.from(await readFile(join(startup, STARTUP_SCRIPT_NAME))).toString('utf16le'), /opencode start/u);
  const disabled = await disableOpencodeService({}, paths, scope);
  assert.equal(disabled.config.autostart_enabled, false); assert.equal(disabled.login.installed, false); assert.equal(env.writes.length, 0);
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
