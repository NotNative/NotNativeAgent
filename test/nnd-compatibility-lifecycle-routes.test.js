// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveOpenCodeConfig } from '../src/opencode/config.js';
import { writeRuntimePid, removeRuntimePid } from '../src/opencode/service.js';
import {
  createNndCompatibilityLifecycleService, projectAction,
} from '../src/nnd-compatibility-lifecycle-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const identity = { installation_id: 'install_lc', data_id: 'data_lc' };
const token = 'compat-lifecycle-test-token-36-chars';

const fixture = async () => {
  const root = await mkdtemp(join(homedir(), '.nna-lifecycle-'));
  const paths = { opencodeConfig: join(root, 'config', 'opencode.json'),
    opencode: join(root, 'runtime', 'opencode'), logs: join(root, 'logs') };
  await mkdir(paths.opencode, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  const service = createNndCompatibilityLifecycleService({ paths, environment: {
    OPENCODE_SERVER_PASSWORD: 'env-password-value-openchamber-123456' },
    installationId: identity.installation_id, dataId: identity.data_id,
    scope: { platform: 'linux' } });
  return { root, paths, service };
};

const identityStub = (compare, platform = 'win32') => ({
  compare: async () => compare, capture: async () => ({ version: 1, pid: 4242, platform, start_id: '1536' }),
  live: () => true });

test('status mirrors the domain view verbatim; non-Windows wiring and probes honestly absent', async () => {
  const f = await fixture();
  try {
    await saveOpenCodeConfig(f.paths.opencodeConfig, { enabled: true, port: 4096,
      password: 'stored-password-value-used-.--only-for-absence-checks..' });
    const raw = await f.service.status();
    assert.deepEqual(Object.keys(raw).sort(), ['dataId', 'installationId', 'operationId', 'value']);
    const projected = projectAction(raw, 'status', 'not_applied', true);
    assert.deepEqual(Object.keys(projected).sort(), ['action', 'application', 'data_id',
      'installation_id', 'operation_id', 'schema_version', 'scope', 'status']);
    assert.equal(projected.application, 'not_applied');
    const status = projected.status;
    assert.deepEqual(Object.keys(status).sort(), ['environment', 'login', 'runtime', 'service', 'stale_binding']);
    assert.deepEqual(Object.keys(status.service).sort(), ['autostart_enabled', 'bind_url', 'configured',
      'hostname', 'password_source', 'port', 'username']);
    assert.equal(status.service.autostart_enabled, true);
    assert.equal(status.service.password_source, 'restricted local config');
    assert.equal(status.service.bind_url, 'http://127.0.0.1:4096');
    assert.deepEqual(status.runtime, { running: false });
    assert.deepEqual(status.login, { supported: false, installed: null, script_path: null });
    assert.deepEqual(status.environment, { supported: false, skip_start: null, host: null,
      password_present: null, username: null });
    assert.equal(status.stale_binding, false);
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes('stored-password-value'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('stop is an honest no-op on absent and stale runtimes, and a verified kill when running', async () => {
  const f = await fixture();
  try {
    // No pid record: not_running receipt with honest reason.
    const raw = await f.service.stop();
    assert.deepEqual(Object.keys(raw.value).sort(), ['environment', 'reason', 'stopped']);
    const projected = projectAction(raw, 'stop', 'stop_service', true);
    assert.match(String(Object.keys(projected).sort()), /operation_id/u);
    assert.equal(projected.stopped, false);
    assert.equal(projected.reason, 'not_running');
    assert.equal(projected.pid, null);
    assert.deepEqual(projected.environment, { supported: false });
    // A stale record with a dead identity is reported honestly, never stopped.
    await writeRuntimePid(f.paths, 4242, { port: 4095, url: 'http://127.0.0.1:4095' },
      { processIdentity: identityStub('dead') });
    const status = projectAction(await f.service.status(), 'status', 'not_applied', true);
    assert.deepEqual(status.status.runtime, { running: false, stale: true, pid: 4242, reason: 'dead' });
    const rawStop = await f.service.stop();
    assert.equal(rawStop.value.stopped, false);
    // A verified runtime is stopped and its pid record removed on Windows.
    const kills = [];
    await writeRuntimePid(f.paths, 4242, { port: 4095, url: 'http://127.0.0.1:4095' },
      { processIdentity: identityStub('same') });
    await removeRuntimePid(f.paths).catch(() => {});
    await writeRuntimePid(f.paths, 4242, { port: 4095, url: 'http://127.0.0.1:4095' },
      { processIdentity: identityStub('same') });
    const stoppedService = createNndCompatibilityLifecycleService({ paths: f.paths, environment: {},
      installationId: identity.installation_id, dataId: identity.data_id, scope: {
        platform: 'win32', kill: (pid) => { kills.push(pid); },
        processIdentity: identityStub('same'), userEnvironmentRead: async () => ({}) } });
    const stopped = await stoppedService.stop();
    assert.equal(stopped.value.stopped, true);
    assert.equal(stopped.value.pid, 4242);
    assert.deepEqual(kills, [4242]);
    const receipt = projectAction(stopped, 'stop', 'stop_service', true);
    assert.equal(receipt.stopped, true);
    assert.equal(receipt.reason, null);
    assert.deepEqual(receipt.environment, { supported: true, written: [], removed: [
      'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('enable installs the login script verbatim; start applies the OpenChamber environment; run honest', async () => {
  const f = await fixture();
  try {
    // Non-Windows wiring is refused before any state change.
    await assert.rejects(() => f.service.enable(), { code: 'opencode_login_wiring_unsupported' });
    const beforeEnable = await readFile(f.paths.opencodeConfig, 'utf8').catch(() => null);
    assert.equal(beforeEnable, null);
    // Windows wiring with injected fakes: the Startup .vbs lands immediately.
    const scripts = [];
    const removed = [];
    const written = [];
    const fakeChild = () => {
      const listeners = {};
      const child = { pid: 777, unref: () => undefined, kill: () => undefined,
        on: (name, listener) => { (listeners[name] ??= []).push(listener); },
        once: (name, listener) => { (listeners[name] ??= []).push(listener); },
        removeListener: (name, listener) => { listeners[name] = (listeners[name] ?? []).filter(item => item !== listener); } };
      setTimeout(() => { for (const listener of listeners.spawn ?? []) listener(); }, 5);
      return child;
    };
    const winService = createNndCompatibilityLifecycleService({ paths: f.paths, environment: {},
      installationId: identity.installation_id, dataId: identity.data_id, scope: {
        platform: 'win32', startupFolder: async () => join(f.root, 'startup'),
        fileWriter: (destination, bytes) => { scripts.push({ destination, bytes }); },
        fileRemove: (target) => { removed.push(target); },
        userEnvironmentRead: async () => ({}),
        userEnvironmentWrite: pairs => { for (const [name, value] of Object.entries(pairs)) written.push([name, value]); },
        processIdentity: identityStub('same'),
        spawnProcess: () => fakeChild() } });
    await mkdir(join(f.root, 'startup'), { recursive: true });
    const enabled = await winService.enable();
    assert.equal(enabled.value.config.autostart_enabled, true);
    assert.equal(enabled.value.login.installed, true);
    assert.equal(scripts.length, 1);
    assert.deepEqual(written, []);
    const receipt = projectAction(enabled, 'enable', 'next_service_start', true);
    assert.equal(receipt.application, 'next_service_start');
    assert.equal(receipt.service.password_source, 'restricted local config');
    assert.equal(receipt.runtime.running, false);
    const encoded = scripts[0].bytes;
    assert.ok(encoded[0] === 0xFF && encoded[1] === 0xFE);
    const script = encoded.toString('utf16le');
    assert.ok(script.includes('-disable-warning=ExperimentalWarning'));
    // enable never touches the user environment; start owns it. The password
    // value never leaves the surface in either receipt.
    const start = await winService.start();
    assert.equal(start.value.started, true);
    assert.equal(start.value.pid, 777);
    // The default username leaves no value behind, so only three names are
    // written; the identity stays in the receipt's unchanged list.
    assert.deepEqual(written.map(([name]) => name), ['OPENCODE_SKIP_START', 'OPENCODE_HOST',
      'OPENCODE_SERVER_PASSWORD']);
    const startReceipt = projectAction(start, 'start', 'start_service', true);
    assert.equal(startReceipt.runtime, null);
    assert.deepEqual(startReceipt.environment, { supported: true, written: [
      'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD'],
      removed: [], unchanged: ['OPENCODE_SERVER_USERNAME'] });
    assert.ok(!JSON.stringify(startReceipt).includes(written[2][1]));
    assert.ok(!JSON.stringify(receipt).includes('disabled-value-never-present-x'));
    const disabled = await winService.disable();
    assert.equal(disabled.value.config.autostart_enabled, false);
    assert.equal(disabled.value.login.installed, false);
    assert.equal(disabled.value.runtime.running, true);
    assert.equal(disabled.value.runtime.verified, true);
    assert.deepEqual(disabled.value.runtime, { running: true, verified: true, pid: 777,
      port: 4095, url: 'http://127.0.0.1:4095' });
    assert.deepEqual(removed, [scripts[0].destination]);
    void [enabled.value.operationId, disabled.value.operationId];
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('http drill: action rights, methods, run refusal, empty-body grammar, and bounds', async () => {
  const f = await fixture();
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'operator@example.com', permissions: [
      'nnd.configuration.read', 'nnd.service.manage'] }),
    nndCompatibilityLifecycleService: f.service });
  try {
    const base = `http://127.0.0.1:${server.address.port}/v1/nnd/configuration/compatibility-service/actions`;
    const call = async (verb, { method = 'GET', bearer = token, body } = {}) => {
      const response = await fetch(`${base}/${verb}`, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body } : {}) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const reading = await call('status');
    assert.equal(reading.status, 200);
    assert.equal(reading.body.action, 'status');
    assert.equal(reading.body.application, 'not_applied');
    assert.equal((await call('stop', { method: 'GET' })).status, 405);
    assert.equal((await call('status', { method: 'POST' })).status, 405);
    assert.equal((await call('unknown')).status, 404);
    assert.equal((await call('run', { method: 'POST' })).status, 400);
    assert.equal((await call('run', { method: 'POST' })).body.error.code, 'nnd_service_run_unsupported');
    assert.equal((await call('enable', { method: 'POST' })).status, 400);
    assert.equal((await call('enable', { method: 'POST' })).body.error.code, 'opencode_login_wiring_unsupported');
    assert.equal((await call('stop', { method: 'POST', body: '{"extraneous":1}' })).status, 400);
    assert.equal((await call('stop', { method: 'POST', body: '{"extraneous":1}' })).body.error.code,
      'nnd_service_action_invalid');
    const stopped = await call('stop', { method: 'POST', body: '{}' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopped, false);
    assert.equal(stopped.body.reason, 'not_running');
    assert.equal((await call('status?x=1')).status, 400);
    assert.equal((await call('status', { bearer: '' })).status, 401);
  } finally { await server.close(); await rm(f.root, { recursive: true, force: true }); }
  // A read-only principal lacks the lifecycle right: actions refuse closed.
  const secondRoot = await mkdtemp(join(homedir(), '.nna-lifecycle-'));
  const paths = { opencodeConfig: join(secondRoot, 'config', 'opencode.json'),
    opencode: join(secondRoot, 'runtime', 'opencode'), logs: join(secondRoot, 'logs') };
  const deniedServer = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => ({ subjectId: 'limited@example.com', permissions: ['nnd.configuration.read'] }),
    nndCompatibilityLifecycleService: createNndCompatibilityLifecycleService({ paths, environment: {},
      installationId: identity.installation_id, dataId: identity.data_id, scope: { platform: 'linux' } }) });
  try {
    const deniedBase = `http://127.0.0.1:${deniedServer.address.port}/v1/nnd/configuration/compatibility-service/actions`;
    const granted = await fetch(`${deniedBase}/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(granted.status, 200);
    const denied = await fetch(`${deniedBase}/stop`, { method: 'POST',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 403);
  } finally { await deniedServer.close(); await rm(secondRoot, { recursive: true, force: true }); }
});
