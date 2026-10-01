// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopSshTransport, makeSshArgs } from './ssh-transport.mjs';

const instance = (overrides = {}) => ({
  id: 'remote-1', sshCommand: 'ssh -p 2222 dev@example.test',
  remoteOpenchamber: { mode: 'external', preferredPort: 57123 },
  localForward: { bindHost: '127.0.0.1', preferredLocalPort: 48123 },
  connectionTimeoutSec: 5,
  ...overrides,
});
const healthyResponse = () => new Response(JSON.stringify({ ok: true, name: 'NotNativeDesktop' }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('builds a no-shell SSH forward and puts enforced safety options first', () => {
  const args = makeSshArgs(instance(), 48123, 57123);
  assert.deepEqual(args.slice(0, 17), [
    '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  ]);
  assert.ok(args.includes('-L'));
  for (const enforced of ['ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no']) {
    assert.ok(args.indexOf(enforced) < args.indexOf('dev@example.test'));
  }
  assert.equal(args.at(-1), 'dev@example.test');
  assert.throws(() => makeSshArgs(instance({ sshCommand: 'ssh -L 0.0.0.0:9000:host:80 dev@example.test' }), 48123, 57123), /SSH option -L/u);
  assert.throws(() => makeSshArgs(instance({ sshCommand: 'ssh -D 9000 dev@example.test' }), 48123, 57123), /forwarding-options-unsupported/u);
});

test('connect reports ready only after health succeeds through the SSH tunnel and disconnect kills its child', async () => {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const events = [];
  const calls = [];
  const transport = createDesktopSshTransport({
    getInstances: () => [instance()], emitStatus: (status) => events.push(status),
    spawnProcess: (...args) => { calls.push(args); return child; },
    fetchImpl: async (url) => { assert.equal(url, 'http://127.0.0.1:48123/health'); return healthyResponse(); },
    now: () => 100, platform: 'linux',
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.ok, true);
  assert.equal(result.result.phase, 'ready');
  assert.equal(events.at(-1).localUrl, 'http://127.0.0.1:48123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ssh');
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][1].at(-1), 'dev@example.test');
  assert.deepEqual(transport.disconnect('remote-1').result.phase, 'idle');
  assert.equal(child.killed, true);
});

test('managed mode requires explicit artifact upload before remote setup', async () => {
  const statuses = [];
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed' } })],
    emitStatus: (status) => statuses.push(status),
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.error, 'desktop-ssh-managed-mode-unavailable');
  assert.equal(statuses.at(-1).phase, 'error');
  assert.equal(statuses.at(-1).requiresUserAction, true);
});

test('managed transport uploads and starts before opening the tunnel, then stops on disconnect when configured', async () => {
  const order = [];
  const child = new EventEmitter(); child.kill = () => { child.killed = true; };
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: false, preferredPort: 57124 } })],
    managedRuntime: {
      start: async (_instance, options) => { order.push(['start', options.port]); return { transferId: 'transfer-123' }; },
      stop: async (_instance, session) => { order.push(['stop', session.transferId]); },
    },
    spawnProcess: () => { order.push(['tunnel']); return child; },
    fetchImpl: async () => { order.push(['health']); return healthyResponse(); },
    chooseLocalPort: async () => 48123,
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.ok, true);
  assert.deepEqual(order, [['start', 57124], ['tunnel'], ['health']]);
  transport.disconnect('remote-1');
  assert.equal(child.killed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order.at(-1), ['stop', 'transfer-123']);
});

test('managed keepRunning reuses its server when the same desktop process reconnects', async () => {
  let starts = 0;
  let stops = 0;
  const makeChild = () => { const child = new EventEmitter(); child.kill = () => {}; return child; };
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: true, preferredPort: 57123 } })],
    managedRuntime: {
      start: async () => { starts += 1; return { transferId: 'transfer-123', port: 57123 }; },
      stop: async () => { stops += 1; },
    },
    spawnProcess: makeChild,
    fetchImpl: async () => healthyResponse(),
    chooseLocalPort: async () => 48123,
  });
  assert.equal((await transport.connect('remote-1')).ok, true);
  transport.disconnect('remote-1');
  assert.equal(stops, 0);
  assert.equal((await transport.connect('remote-1')).ok, true);
  assert.equal(starts, 1);
  transport.disconnect('remote-1');
  assert.equal(stops, 0);
});

test('a failed managed health probe cleans up a server even when keepRunning is true', async () => {
  const stops = [];
  let clock = 0;
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: true } })],
    managedRuntime: { start: async () => ({ transferId: 'transfer-123' }), stop: async (_instance, session) => stops.push(session.transferId) },
    spawnProcess: () => { const child = new EventEmitter(); child.kill = () => {}; return child; },
    fetchImpl: async () => ({ ok: false }),
    chooseLocalPort: async () => 48123,
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.ok, false);
  assert.deepEqual(stops, ['transfer-123']);
});

test('a tunnel process spawn failure cleans up a managed server when keepRunning is false', async () => {
  const stops = [];
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: false } })],
    managedRuntime: { start: async () => ({ transferId: 'transfer-123' }), stop: async (_instance, session) => stops.push(session.transferId) },
    spawnProcess: () => { throw new Error('ssh executable missing'); },
    chooseLocalPort: async () => 48123,
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.error, 'ssh executable missing');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, ['transfer-123']);
});

test('an SSH tunnel exit after readiness stops a non-persistent managed server', async () => {
  const stops = [];
  const child = new EventEmitter(); child.kill = () => {};
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: false } })],
    managedRuntime: { start: async () => ({ transferId: 'transfer-123' }), stop: async (_instance, session) => stops.push(session.transferId) },
    spawnProcess: () => child,
    fetchImpl: async () => healthyResponse(),
    chooseLocalPort: async () => 48123,
  });
  assert.equal((await transport.connect('remote-1')).ok, true);
  child.emit('exit', 255);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, ['transfer-123']);
  assert.equal(transport.getStatus('remote-1').phase, 'error');
});

test('a synchronous managed cleanup error does not break disconnect state', () => {
  const child = new EventEmitter(); child.kill = () => {};
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ remoteOpenchamber: { mode: 'managed', uploadBundleOverSsh: true, keepRunning: false } })],
    managedRuntime: { start: async () => ({ transferId: 'transfer-123' }), stop: () => { throw new Error('remote unavailable'); } },
    spawnProcess: () => child,
    fetchImpl: async () => healthyResponse(),
    chooseLocalPort: async () => 48123,
  });
  return transport.connect('remote-1').then(() => {
    assert.equal(transport.disconnect('remote-1').result.phase, 'idle');
  });
});

test('reports a failed remote health probe and terminates the SSH process', async () => {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const statuses = [];
  let clock = 0;
  const transport = createDesktopSshTransport({
    getInstances: () => [instance()], emitStatus: (status) => statuses.push(status),
    spawnProcess: () => child, fetchImpl: async () => ({ ok: false }),
    chooseLocalPort: async () => 48123, now: () => clock,
    sleep: async (duration) => { clock += duration; },
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.error, 'desktop-ssh-remote-health-timeout');
  assert.equal(child.killed, true);
  assert.equal(statuses.at(-1).phase, 'error');
});

test('reserves an instance during asynchronous local-port selection and cancellation prevents spawn', async () => {
  let resolvePort;
  let spawnCount = 0;
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ localForward: {} })],
    chooseLocalPort: () => new Promise((resolve) => { resolvePort = resolve; }),
    spawnProcess: () => { spawnCount += 1; return new EventEmitter(); },
  });
  const first = transport.connect('remote-1');
  const second = await transport.connect('remote-1');
  assert.equal(second.error, 'desktop-ssh-already-connected-or-connecting');
  transport.cancel('remote-1');
  resolvePort(48123);
  assert.equal((await first).error, 'desktop-ssh-connect-cancelled');
  assert.equal(spawnCount, 0);
});

test('forgetting a removed instance prevents an in-flight cancellation from restoring its status', async () => {
  let resolvePort;
  const events = [];
  const transport = createDesktopSshTransport({
    getInstances: () => [instance({ localForward: {} })],
    emitStatus: (status) => events.push(status),
    chooseLocalPort: () => new Promise((resolve) => { resolvePort = resolve; }),
    spawnProcess: () => new EventEmitter(),
  });
  const connecting = transport.connect('remote-1');
  transport.disconnect('remote-1');
  const eventsAtRemoval = events.length;
  transport.forgetStatus('remote-1');
  resolvePort(48123);
  assert.equal((await connecting).error, 'desktop-ssh-connect-cancelled');
  assert.deepEqual(transport.getStatuses(), []);
  assert.equal(events.length, eventsAtRemoval);
});

test('a cancelled older connect cannot overwrite the status of a newer attempt', async () => {
  let releaseFirstProbe;
  let firstProbeStarted;
  const started = new Promise((resolve) => { firstProbeStarted = resolve; });
  const events = [];
  const child = () => {
    const process = new EventEmitter();
    process.kill = () => {};
    return process;
  };
  let probes = 0;
  const transport = createDesktopSshTransport({
    getInstances: () => [instance()], emitStatus: (status) => events.push(status),
    spawnProcess: child,
    fetchImpl: () => {
      probes += 1;
      if (probes === 1) {
        firstProbeStarted();
        return new Promise((resolve) => { releaseFirstProbe = resolve; });
      }
      return Promise.resolve(healthyResponse());
    },
    sleep: async () => {},
  });
  const oldAttempt = transport.connect('remote-1');
  await started;
  transport.disconnect('remote-1');
  const newAttempt = await transport.connect('remote-1');
  assert.equal(newAttempt.result.phase, 'ready');
  releaseFirstProbe(healthyResponse());
  assert.equal((await oldAttempt).error, 'desktop-ssh-connect-cancelled');
  assert.equal(transport.getStatuses()[0].phase, 'ready');
  assert.equal(events.at(-1).phase, 'ready');
});

test('does not treat a redirected health response as remote readiness', async () => {
  let clock = 0;
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const transport = createDesktopSshTransport({
    getInstances: () => [instance()], spawnProcess: () => child,
    fetchImpl: async () => new Response('redirect', { status: 302, headers: { location: 'https://other.example/' } }),
    now: () => clock, sleep: async (duration) => { clock += duration; },
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.error, 'desktop-ssh-remote-health-timeout');
  assert.equal(child.killed, true);
});

test('does not treat an unrelated service on the local port as remote readiness', async () => {
  let clock = 0;
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const transport = createDesktopSshTransport({
    getInstances: () => [instance()], spawnProcess: () => child,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, name: 'OtherService' }), { status: 200 }),
    now: () => clock, sleep: async (duration) => { clock += duration; },
  });
  const result = await transport.connect('remote-1');
  assert.equal(result.error, 'desktop-ssh-remote-health-timeout');
  assert.equal(child.killed, true);
});
