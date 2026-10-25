// SPDX-License-Identifier: Apache-2.0
/** P11 §H.3 relay dev-tunnel bridge lifecycle contract. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { createRelayDevTunnelBridge } from './relay-dev-tunnel.mjs';

function createPort(id) {
  return {
    id,
    handlers: {},
    on(type, handler) { (this.handlers[type] ??= []).push(handler); },
    emit(type, event) { for (const handler of this.handlers[type] ?? []) handler(event); },
    postMessage(message) { this.messages.push(message); },
    start() {},
    close() { this.closed = true; },
    messages: [],
  };
}

function createPorts() {
  return [createPort(0), createPort(1)];
}

function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = condition();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('condition expired'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

test('reuses a route and transfers a new connection port on each accept', async () => {
  const posts = [];
  let bridgePort;
  let rendererPort;
  const portFactory = () => {
    const ports = createPorts();
    bridgePort = ports[0];
    rendererPort = ports[1];
    return ports;
  };
    const bridge = createRelayDevTunnelBridge({
    createPorts: portFactory,
    postMessage: (payload, port) => posts.push({ payload, port }),
  });
  const shell = {
    id: 42,
    isDestroyed: () => false,
    once(_event, handler) { this.onDestroyed = handler; },
  };
  const first = await bridge.open({ targetKey: 'base', remotePort: 3000, webContents: shell });
  const second = await bridge.open({ targetKey: 'base', remotePort: 3000, webContents: shell });
  assert.equal(second.localPort, first.localPort);
  assert.equal(second.reused, true);
  assert.equal(bridge.mappingCount(), 1);
  const source = connect(first.localPort, '127.0.0.1');
  await once(source, 'connect');
  const post = await waitFor(() => posts.at(-1));
  assert.match(post.payload.connectionId, /^relay-dev-tunnel-/u);
  assert.equal(post.payload.remotePort, 3000);
  assert.deepEqual(post.port, [rendererPort]);
  source.destroy();
  shell.onDestroyed?.();
  await waitFor(() => source.destroyed);
  assert.equal(bridge.mappingCount(), 0);
});

test('coalesces concurrent opens for the same route without leaking a listener', async (t) => {
  const bridge = createRelayDevTunnelBridge({ createPorts, postMessage: () => undefined });
  t.after(() => bridge.closeAll());
  const shell = { id: 43, isDestroyed: () => false, once() {} };
  const [first, second] = await Promise.all([
    bridge.open({ targetKey: 'same-target', remotePort: 3000, webContents: shell }),
    bridge.open({ targetKey: 'same-target', remotePort: 3000, webContents: shell }),
  ]);
  assert.equal(first.localPort, second.localPort);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
  assert.equal(bridge.mappingCount(), 1);
});

test('does not publish a listener when webContents dies during listen', async () => {
  let checks = 0;
  const shell = { id: 44, isDestroyed: () => ++checks > 1, once() {} };
  const bridge = createRelayDevTunnelBridge({ createPorts, postMessage: () => undefined });
  await assert.rejects(bridge.open({ targetKey: 'dying-target', remotePort: 3000, webContents: shell }), /webContents is gone/u);
  assert.equal(bridge.mappingCount(), 0);
});

test('rejects missing or malformed paired ports without crashing the accepted socket', async (t) => {
  for (const createPorts of [undefined, () => [createPort('bridge'), null], () => ({})]) {
    const bridge = createRelayDevTunnelBridge({ createPorts, postMessage: () => undefined });
    t.after(() => bridge.closeAll());
    const shell = { id: 45, isDestroyed: () => false, once() {} };
    const route = await bridge.open({ targetKey: `invalid-ports-${bridge.mappingCount()}`, remotePort: 3000, webContents: shell });
    const source = connect(route.localPort, '127.0.0.1');
    t.after(() => source.destroy());
    await once(source, 'connect');
    await once(source, 'close');
    assert.equal(bridge.connectionCount(), 0);
  }
});

test('closes both paired ports if handing the renderer port to webContents fails', async (t) => {
  const [bridgePort, rendererPort] = createPorts();
  const bridge = createRelayDevTunnelBridge({
    createPorts: () => [bridgePort, rendererPort],
    postMessage: () => { throw new Error('renderer gone'); },
  });
  t.after(() => bridge.closeAll());
  const shell = { id: 46, isDestroyed: () => false, once() {} };
  const route = await bridge.open({ targetKey: 'transfer-failure', remotePort: 3000, webContents: shell });
  const source = connect(route.localPort, '127.0.0.1');
  t.after(() => source.destroy());
  await once(source, 'connect');
  await once(source, 'close');
  assert.equal(bridgePort.closed, true);
  assert.equal(rendererPort.closed, true);
  assert.equal(bridge.connectionCount(), 0);
});

test('times out an unready connection without touching the listener', async () => {
  const bridge = createRelayDevTunnelBridge({
    createPorts,
    readinessTimeoutMs: 20,
    postMessage: () => undefined,
  });
  const shell = {
    id: 42,
    isDestroyed: () => false,
    once(_event, handler) { this.onDestroyed = handler; },
  };
  const route = await bridge.open({ targetKey: 'base', remotePort: 3000, webContents: shell });
  const source = connect(route.localPort, '127.0.0.1');
  await once(source, 'connect');
  await waitFor(() => source.destroyed);
  assert.equal(bridge.connectionCount(), 0);
  assert.equal(bridge.mappingCount(), 1);
  bridge.closeAll();
});

test('bridges buffered bytes after readiness and propagates close', async () => {
  const posts = [];
  let bridgePort;
  const portFactory = () => {
    const ports = createPorts();
    bridgePort = ports[0];
    return ports;
  };
  const bridge = createRelayDevTunnelBridge({
    createPorts: portFactory,
    postMessage: (payload, port) => posts.push({ payload, port }),
  });
  const shell = {
    id: 42,
    isDestroyed: () => false,
    once(_event, handler) { this.onDestroyed = handler; },
  };
  const route = await bridge.open({ targetKey: 'base', remotePort: 3000, webContents: shell });
  const source = connect(route.localPort, '127.0.0.1');
  await once(source, 'connect');
  const post = await waitFor(() => posts.at(-1));
  source.write('held');
  bridgePort.emit('message', { type: 'message', data: { type: 'ready', connectionId: post.payload.connectionId } });
  await waitFor(() => bridgePort.messages.length === 1);
  assert.equal(Buffer.from(bridgePort.messages[0].data).toString(), 'held');
  source.write('live');
  await waitFor(() => bridgePort.messages.length === 2);
  bridgePort.emit('message', { type: 'message', data: { type: 'close', connectionId: post.payload.connectionId } });
  await waitFor(() => source.destroyed);
  try { bridge.closeAll(); } catch {}
});

test('transfers a real paired MessageChannel port and round-trips TCP bytes', async (t) => {
  const transfers = [];
  const webContents = {
    id: 97, isDestroyed: () => false,
    once() {},
    postMessage(channel, payload, ports) {
      assert.equal(channel, 'openchamber:relay-dev-tunnel-connect');
      assert.equal(payload.type, 'connect');
      transfers.push({ payload, port: ports[0] });
    },
  };
  const bridge = createRelayDevTunnelBridge({
    createPorts: () => { const channel = new MessageChannel(); return [channel.port1, channel.port2]; },
    postMessage: (payload, ports, owner) => owner.postMessage('openchamber:relay-dev-tunnel-connect', { type: 'connect', ...payload }, ports),
  });
  t.after(() => bridge.closeAll());
  const route = await bridge.open({ targetKey: 'https://host.example', remotePort: 3000, webContents });
  const source = connect(route.localPort, '127.0.0.1');
  t.after(() => source.destroy());
  await once(source, 'connect');
  const transfer = await waitFor(() => transfers[0]);
  const rendererPort = transfer.port;
  t.after(() => rendererPort.close());
  rendererPort.start();
  const receivedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer did not receive tunnel data')), 1000);
    rendererPort.on('message', (message) => {
      if (message.type === 'data') { clearTimeout(timer); resolve(Buffer.from(message.data).toString()); }
    });
  });
  rendererPort.postMessage({ type: 'ready', connectionId: transfer.payload.connectionId });
  source.write('main-to-renderer');
  const received = await receivedPromise;
  assert.equal(received, 'main-to-renderer');
  const sourceData = once(source, 'data');
  rendererPort.postMessage({ type: 'data', connectionId: transfer.payload.connectionId, data: new Uint8Array(Buffer.from('renderer-to-main')) });
  assert.equal((await sourceData)[0].toString(), 'renderer-to-main');
  bridge.closeForWebContents(webContents.id);
  rendererPort.close();
});

test('closes all routes for endpoint switching and webContents death', async () => {
  const bridge = createRelayDevTunnelBridge({ createPorts, postMessage: () => undefined });
  const shell = {
    id: 42,
    isDestroyed: () => false,
    once(_event, handler) { this.onDestroyed = handler; },
  };
  await bridge.open({ targetKey: 'old', remotePort: 3000, webContents: shell });
  await bridge.open({ targetKey: 'new', remotePort: 3000, webContents: shell });
  assert.equal(bridge.mappingCount(), 2);
  bridge.closeAll();
  assert.equal(bridge.mappingCount(), 0);
  await bridge.open({ targetKey: 'death', remotePort: 3000, webContents: shell });
  shell.onDestroyed?.();
  assert.equal(bridge.mappingCount(), 0);
  assert.equal(bridge.connectionCount(), 0);
});




