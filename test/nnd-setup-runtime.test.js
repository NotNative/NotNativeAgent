// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createNndSetupRuntime } from '../src/nnd-setup-runtime.js';
import { readNndSetupConfiguration } from '../src/nnd-setup-config.js';
import { createIntegrationLifecycle, createIntegrationNndEngineHost, runNndIntegrationCommand } from '../src/integration-cli.js';
import { NndEngineHost } from '../src/nnd-engine-host.js';

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, config: join(root, 'config'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
    secretVault: join(root, 'secrets', 'vault.json'), secretKey: join(root, 'secrets', 'key.json'),
    secretAudit: join(root, 'secrets', 'audit.ndjson') };
  await mkdir(paths.config); await mkdir(paths.sessions);
  return paths;
}
function manifest(root) {
  return { format_version: 1, persistence: 'durable', workspace_root: root,
    provider: { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'test', trust_zone: 'loopback' } };
}

test('missing and corrupt configuration keep setup available without constructing an engine', async (t) => {
  const paths = await fixture(t);
  let creates = 0;
  const runtime = createNndSetupRuntime({ loadConfiguration: () => readNndSetupConfiguration(paths),
    createHost: () => { creates++; throw new Error('must not construct'); } });
  t.after(() => runtime.close());
  assert.equal((await runtime.activate()).service_state, 'setup_required');
  const path = join(paths.config, 'manifest.json');
  for (const bytes of ['{invalid', JSON.stringify({ ...manifest(paths.root), workspace_root: undefined }),
    JSON.stringify({ ...manifest(paths.root), workspace_root: 'relative' }), ' '.repeat(1_048_577)]) {
    await writeFile(path, bytes);
    const result = await runtime.activate();
    assert.equal(result.failure_code, 'nnd_setup_configuration_invalid');
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  assert.equal(creates, 0);
  assert.equal(runtime.getHost(), null);
});

test('externally repaired configuration activates a real host without provider network access', async (t) => {
  const paths = await fixture(t);
  const runtime = createNndSetupRuntime({ loadConfiguration: () => readNndSetupConfiguration(paths),
    createHost: (preparedConfig) => createIntegrationNndEngineHost(paths, { preparedConfig,
      providerFactory: () => { throw new Error('unexpected provider construction'); } }) });
  t.after(() => runtime.close());
  await runtime.activate();
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(manifest(paths.root)));
  const status = await runtime.activate();
  assert.equal(status.service_state, 'ready');
  assert.equal(status.execution_state, 'ready');
  assert.equal(status.provider_state, 'unknown');
  assert.equal(runtime.getHost().workspaceRoot, paths.root);
  assert.equal((await runtime.activate()).service_state, 'ready');
});

test('corrupt session catalog is host failure rather than invalid configuration', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(manifest(paths.root)));
  await writeFile(join(paths.sessions, 'nnd-contexts.json'), '{broken');
  const runtime = createNndSetupRuntime({ loadConfiguration: () => readNndSetupConfiguration(paths),
    createHost: (preparedConfig) => createIntegrationNndEngineHost(paths, { preparedConfig }) });
  t.after(() => runtime.close());
  assert.deepEqual(await runtime.activate(), { service_state: 'failed', configuration_state: 'ready',
    execution_state: 'unavailable', provider_state: 'unknown', failure_code: 'nnd_setup_host_failed' });
  assert.equal(runtime.getFailure().code, 'nnd_catalog_invalid');
  assert.equal(runtime.getHost(), null);
  assert.equal(await readFile(join(paths.sessions, 'nnd-contexts.json'), 'utf8'), '{broken');
});

test('activation rejects concurrent work and shutdown disposes an unpublished candidate once', async () => {
  let finish;
  let creates = 0; let closed = 0;
  const candidate = { shutdown: async () => { closed++; } };
  const runtime = createNndSetupRuntime({ loadConfiguration: async () => ({}),
    createHost: async () => { creates++; return new Promise((resolve) => { finish = resolve; }); } });
  const activation = runtime.activate();
  await Promise.resolve();
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_busy' });
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  finish(candidate);
  await activation; await closing;
  assert.equal(creates, 1); assert.equal(closed, 1); assert.equal(runtime.getHost(), null);
  assert.equal(runtime.snapshot().service_state, 'stopped');
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_stopped' });
});

test('candidate cleanup failure is surfaced by shutdown', async () => {
  let finish;
  const runtime = createNndSetupRuntime({ loadConfiguration: async () => ({}),
    createHost: () => new Promise((resolve) => { finish = resolve; }) });
  const activation = runtime.activate(); await Promise.resolve();
  const closing = runtime.close();
  const rejected = assert.rejects(closing, { code: 'nnd_setup_host_failed' });
  finish({ shutdown: async () => { throw new Error('cleanup failed'); } });
  await activation; await rejected;
  assert.equal(runtime.snapshot().service_state, 'failed');
});

test('local CLI publishes authenticated listener even when no manifest exists', async (t) => {
  const paths = await fixture(t);
  const controller = new AbortController(); const frames = [];
  await runNndIntegrationCommand(['serve'], paths, { environment: {}, signal: controller.signal,
    output: { write(line) { frames.push(JSON.parse(line)); queueMicrotask(() => controller.abort()); } } });
  assert.equal(frames.length, 1); assert.equal(frames[0].type, 'ready');
});

test('real factory cleans a partially initialized host and retains both failures', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(manifest(paths.root)));
  let disposed = 0;
  const initialization = new Error('initialization failed');
  const cleanup = new Error('cleanup failed');
  t.mock.method(NndEngineHost.prototype, 'initialize', async () => { throw initialization; });
  t.mock.method(NndEngineHost.prototype, 'shutdown', async () => { disposed++; throw cleanup; });
  await assert.rejects(createIntegrationNndEngineHost(paths), (error) => {
    assert.equal(error.code, 'nnd_setup_cleanup_failed');
    assert.deepEqual(error.cause.errors, [initialization, cleanup]); return true;
  });
  assert.equal(disposed, 1);
  const runtime = createNndSetupRuntime({ loadConfiguration: () => readNndSetupConfiguration(paths),
    createHost: (preparedConfig) => createIntegrationNndEngineHost(paths, { preparedConfig }) });
  assert.equal((await runtime.activate()).failure_code, 'nnd_setup_cleanup_failed');
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_cleanup_failed' });
  assert.equal(disposed, 2, 'retry must not construct another host after failed cleanup');
  await assert.rejects(runtime.close(), { code: 'nnd_setup_host_failed' });
});

test('shutdown during configuration validation prevents host construction', async () => {
  let loaded; let created = 0;
  const runtime = createNndSetupRuntime({ loadConfiguration: () => new Promise((resolve) => { loaded = resolve; }),
    createHost: async () => { created++; return { shutdown: async () => {} }; } });
  const activation = runtime.activate();
  const closing = runtime.close(); loaded({});
  await activation; await closing;
  assert.equal(created, 0); assert.equal(runtime.snapshot().service_state, 'stopped');
});

test('failed engine cleanup during catalog restoration prevents a second writer', async (t) => {
  const paths = await fixture(t);
  const catalog = join(paths.sessions, 'nnd-contexts.json');
  await writeFile(catalog, JSON.stringify([{ sessionId: 'session_test', subjectId: 'operator',
    workspaceIds: ['workspace'], title: 'Restored', directory: paths.root, createdAt: 1 }]));
  let engines = 0;
  const runtime = createNndSetupRuntime({ loadConfiguration: async () => ({}), createHost: async () => {
    const host = new NndEngineHost({ catalogPath: catalog, createEngine: async () => {
      engines++;
      return { initialize: async () => { throw new Error('engine init'); },
        shutdown: async () => { throw new Error('engine cleanup'); } };
    } });
    await host.initialize(); return host;
  } });
  assert.equal((await runtime.activate()).failure_code, 'nnd_setup_cleanup_failed');
  assert.equal(runtime.getFailure().cause.errors.length, 2);
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_cleanup_failed' });
  assert.equal(engines, 1);
  await assert.rejects(runtime.close(), { code: 'nnd_setup_host_failed' });
});

test('slow host restoration does not delay the authenticated repair listener', { timeout: 5000 }, async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(manifest(paths.root)));
  let releaseHost; let entered;
  const initializing = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { releaseHost = resolve; });
  let shutdowns = 0;
  t.mock.method(NndEngineHost.prototype, 'initialize', async () => { entered(); await held; });
  t.mock.method(NndEngineHost.prototype, 'shutdown', async () => { shutdowns++; });
  const controller = new AbortController(); let announce;
  const announced = new Promise((resolve) => { announce = resolve; });
  const running = runNndIntegrationCommand(['serve'], paths, { environment: {}, signal: controller.signal,
    output: { write(line) { announce(JSON.parse(line)); } } });
  t.after(async () => { controller.abort(); releaseHost(); await running; });
  const frame = await Promise.race([announced, running.then(() => { throw new Error('Exited before listener readiness.'); })]);
  await initializing;
  const actor = { subject_id: 'operator', platform_role: 'user', permissions: ['nnd.setup.read', 'integration.health'],
    workspace_ids: [], group_ids: [], trace_id: 'trace', request_id: 'request', issued_at: new Date().toISOString() };
  const headers = { authorization: `Bearer ${frame.token}`, 'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url') };
  for (const route of ['/v1/nnd/setup/status', '/v1/health']) {
    const response = await fetch(frame.endpoint + route, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.service_state, 'starting'); assert.equal(status.execution_state, 'unavailable');
  }
  controller.abort();
  releaseHost(); await running;
  assert.ok(shutdowns >= 1);
});

test('activation and close timeouts retain candidate ownership and permanently refuse retry', async () => {
  let release; let signal; let cleaned;
  const cleanedUp = new Promise((resolve) => { cleaned = resolve; });
  let creates = 0;
  const runtime = createNndSetupRuntime({ activationTimeoutMs: 100, closeTimeoutMs: 100,
    loadConfiguration: async () => ({}), createHost: (_config, options) => {
      creates++; signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    } });
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_activation_timeout' });
  assert.equal(signal.aborted, true);
  assert.equal(runtime.getHost(), null);
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_activation_timeout' });
  await assert.rejects(runtime.close(), { code: 'nnd_setup_shutdown_timeout' });
  release({ shutdown: async () => { cleaned(); } });
  await cleanedUp;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1); assert.equal(runtime.getHost(), null);
  assert.equal(runtime.snapshot().service_state, 'stopped');
  await assert.rejects(runtime.activate(), { code: 'nnd_setup_stopped' });
});

test('lifecycle timeout limits cannot be disabled or made unbounded', () => {
  for (const value of [0, -1, 99, 300001, Infinity, NaN]) {
    assert.throws(() => createNndSetupRuntime({ loadConfiguration: async () => ({}), createHost: async () => ({}),
      activationTimeoutMs: value }), { code: 'nnd_setup_timeout_invalid' });
  }
});

test('native integration forwards the supervised activation bound to setup runtime validation', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(createIntegrationLifecycle(paths, { activationTimeoutMs: 99 }, 'nnd', null, {}),
    { code: 'nnd_setup_timeout_invalid' });
});

test('an open SSE connection cannot hold native CLI shutdown indefinitely', { timeout: 5000 }, async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(manifest(paths.root)));
  let shutdowns = 0;
  t.mock.method(NndEngineHost.prototype, 'initialize', async function () {
    this.eventBus = { subscribe(response) { response.write(': held\n\n'); return () => {}; } };
  });
  t.mock.method(NndEngineHost.prototype, 'shutdown', async () => { shutdowns++; });
  const controller = new AbortController(); let announce;
  const announced = new Promise((resolve) => { announce = resolve; });
  const running = runNndIntegrationCommand(['serve'], paths, { environment: {}, signal: controller.signal,
    output: { write(line) { announce(JSON.parse(line)); } } });
  t.after(async () => { controller.abort(); await running; });
  const frame = await announced;
  const actor = { subject_id: 'operator', platform_role: 'user', permissions: ['nnd.read', 'integration.health'],
    workspace_ids: ['workspace'], group_ids: [], trace_id: 'trace', request_id: 'request', issued_at: new Date().toISOString() };
  const headers = { authorization: `Bearer ${frame.token}`, 'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url') };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(frame.endpoint + '/v1/health', { headers });
    if ((await response.json()).execution_state === 'ready') { ready = true; break; }
  }
  assert.equal(ready, true);
  const stream = await fetch(frame.endpoint + '/event', { headers });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  controller.abort();
  await running;
  assert.equal(shutdowns, 1);
  try { await reader.read(); } catch (error) { assert.equal(error.name, 'TypeError'); }
  reader.releaseLock();
});
