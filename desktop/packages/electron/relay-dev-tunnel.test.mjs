// SPDX-License-Identifier: Apache-2.0
/** P11 §H.3 relay dev-tunnel bridge lifecycle contract. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createRelayDevTunnelBridge } from './relay-dev-tunnel.mjs';

function createPort(id) {
  return {
    id,
    handlers: {},
    on(type, handler) { (this.handlers[type] ??= []).push(handler); },
    emit(type, event) { for (const handler of this.handlers[type] ?? []) handler(event); },
    postMessage(message) { this.messages.push(message); },
    start() {},
    close() {},
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
  bridgePort.emit('message', { data: { type: 'ready', connectionId: post.payload.connectionId } });
  await waitFor(() => bridgePort.messages.length === 1);
  assert.equal(Buffer.from(bridgePort.messages[0].data).toString(), 'held');
  source.write('live');
  await waitFor(() => bridgePort.messages.length === 2);
  bridgePort.emit('message', { data: { type: 'close', connectionId: post.payload.connectionId } });
  await waitFor(() => source.destroyed);
  try { bridge.closeAll(); } catch {}
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




