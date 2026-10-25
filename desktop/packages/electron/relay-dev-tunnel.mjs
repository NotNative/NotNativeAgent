// SPDX-License-Identifier: Apache-2.0
/**
 * Relay dev-tunnel bridge (doc 13 §H.3). Binds one private loopback listener
 * per renderer/target/port, but never resumes a local socket until its trusted
 * renderer says the virtual WebSocket is ready. MessagePort failure affects
 * only its connection; webContents death closes the renderer's routes.
 */
import { createServer } from 'node:net';

const MAX_PENDING_BYTES = 256 * 1024;

function validateRemotePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('Remote dev-tunnel port must be between 1 and 65535.');
  }
}

function isMessagePort(port) {
  return Boolean(port && typeof port.postMessage === 'function' && typeof port.close === 'function'
    && (typeof port.on === 'function' || 'onmessage' in port));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const succeed = () => { server.off('error', fail); resolve(); };
    const fail = (error) => { server.off('listening', succeed); reject(error); };
    server.once('error', fail);
    server.once('listening', succeed);
    server.listen(0, '127.0.0.1');
  });
}

export function createRelayDevTunnelBridge(options = {}) {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
  let nextConnectionId = 0;
  const mappings = new Map();
  const connectionsByLocalPort = new Map();
  const routesByWebContents = new Map();

  function closeConnection(connection) {
    if (connection.timer) clearTimeout(connection.timer);
    connection.timer = null;
    if (connection.closed) return;
    connection.closed = true;
    const ports = connectionsByLocalPort.get(connection.localPort);
    ports?.delete(connection);
    if (ports?.size === 0) connectionsByLocalPort.delete(connection.localPort);
    try { connection.bridgePort.close(); } catch { /* already closed */ }
    // If transfer failed, rendererPort is still owned by this process. After a
    // successful transfer it is detached, so close is either harmless or
    // throws and is intentionally best-effort.
    try { connection.rendererPort.close(); } catch { /* detached or already closed */ }
    try { connection.source.destroy(); } catch { /* already gone */ }
  }

  function closeRoute(route) {
    for (const connection of [...(connectionsByLocalPort.get(route.localPort) ?? [])]) closeConnection(connection);
    if (!route.server.closed) route.server.close();
    route.server.closeAllConnections?.();
    for (const [key, candidate] of [...mappings]) if (candidate === route) mappings.delete(key);
  }
  function closeForWebContents(webContentsId) {
    const routes = routesByWebContents.get(webContentsId);
    if (!routes) return;
    routesByWebContents.delete(webContentsId);
    for (const key of [...routes]) {
      const route = mappings.get(key);
      if (route) closeRoute(route);
    }
  }

  function createBridgePort(route, remotePort, source) {
    let created;
    try { created = options.createPorts?.() ?? [null, null]; }
    catch { source.destroy(); return; }
    const [bridgePort, rendererPort] = Array.isArray(created) ? created : [null, null];
    if (!isMessagePort(bridgePort) || !isMessagePort(rendererPort)) {
      for (const port of [bridgePort, rendererPort]) {
        try { port?.close?.(); } catch { /* invalid or already closed */ }
      }
      source.destroy();
      return;
    }
    const connectionId = `relay-dev-tunnel-${nextConnectionId += 1}`;
    const connection = {
      id: connectionId, localPort: route.localPort, source, bridgePort, rendererPort,
      pending: { bytes: 0, chunks: [] }, ready: false, timer: null, closed: false,
    };
    const ports = connectionsByLocalPort.get(route.localPort) ?? new Set();
    ports.add(connection);
    connectionsByLocalPort.set(route.localPort, ports);
    connection.timer = setTimeout(() => closeConnection(connection), readinessTimeoutMs);
    const handleMessage = (event) => {
      // Electron MessagePortMain emits a MessageEvent (`type === "message"`),
      // while Node MessagePort emits the payload directly. Normalize both.
      const message = event && typeof event === 'object' && 'data' in event
        && (event.type === 'message' || !('connectionId' in event))
        ? event.data : event;
      if (message?.connectionId !== connectionId || connection.closed) return;
      if (message.type === 'ready') {
        clearTimeout(connection.timer);
        connection.timer = null;
        connection.ready = true;
        try {
          for (const chunk of connection.pending.chunks) bridgePort.postMessage({
            type: 'data', connectionId, data: new Uint8Array(chunk),
          });
          connection.pending = { bytes: 0, chunks: [] };
          source.resume();
        } catch { closeConnection(connection); }
      } else if (message.type === 'data' && connection.ready) {
        const data = message.data;
        if (data instanceof Uint8Array) source.write(Buffer.from(data));
        else if (data instanceof ArrayBuffer) source.write(Buffer.from(data));
      } else if (message.type === 'close') closeConnection(connection);
    };
    const handleClose = () => closeConnection(connection);
    if (typeof bridgePort.on === 'function') {
      bridgePort.on('message', handleMessage);
      bridgePort.on('close', handleClose);
    } else {
      bridgePort.onmessage = handleMessage;
      bridgePort.onclose = handleClose;
    }
    try { bridgePort.start?.(); }
    catch { closeConnection(connection); return; }
    source.on('readable', () => {
      if (connection.closed) return;
      const chunk = source.read();
      if (!chunk) return;
      const bytes = Buffer.from(chunk);
      if (connection.pending.bytes + bytes.byteLength > MAX_PENDING_BYTES) closeConnection(connection);
      else if (connection.ready) {
        try {
          bridgePort.postMessage({ type: 'data', connectionId, data: new Uint8Array(bytes) });
        } catch { closeConnection(connection); }
      }
      else {
        connection.pending.bytes += bytes.byteLength;
        connection.pending.chunks.push(bytes);
      }
    });
    source.once('close', () => {
      closeConnection(connection);
      try { bridgePort.postMessage({ type: 'close', connectionId }); } catch { /* renderer gone */ }
    });
    source.once('error', () => {
      closeConnection(connection);
      try { bridgePort.postMessage({ type: 'close', connectionId }); } catch { /* renderer gone */ }
    });
    try { options.postMessage?.({ connectionId, remotePort }, [rendererPort], route.webContents); }
    catch { closeConnection(connection); }
  }

  async function afterOpen(input, key) {
    validateRemotePort(input.remotePort);
    const webContentsId = Number(input.webContents?.id);
    if (typeof input.targetKey !== 'string' || !input.targetKey || !Number.isInteger(webContentsId)) throw new RangeError('Invalid relay dev-tunnel route.');
    const existing = mappings.get(key);
    if (existing) return { localPort: existing.localPort, reused: true };
    if (input.webContents.isDestroyed?.()) throw new Error('Relay dev-tunnel webContents is gone.');
    const server = createServer((source) => {
      const route = mappings.get(key);
      if (!route) { source.destroy(); return; }
      createBridgePort(route, input.remotePort, source);
    });
    await listen(server);
    // Multiple IPC opens for the same owner/target can reach this await before
    // either listener is registered. Keep only the first route and close the
    // redundant listener so concurrent preview resolution cannot leak ports.
    const raced = mappings.get(key);
    if (raced) {
      server.close();
      server.closeAllConnections?.();
      return { localPort: raced.localPort, reused: true };
    }
    if (input.webContents.isDestroyed?.()) {
      server.close();
      server.closeAllConnections?.();
      throw new Error('Relay dev-tunnel webContents is gone.');
    }
    const route = { localPort: server.address().port, server, webContentsId, webContents: input.webContents };
    mappings.set(key, route);
    const routes = routesByWebContents.get(webContentsId) ?? new Set();
    routes.add(key);
    routesByWebContents.set(webContentsId, routes);
    input.webContents.once?.('destroyed', () => closeForWebContents(webContentsId));
    return { localPort: route.localPort, reused: false };
  }

  function open(input) {
    const targetKey = typeof input.targetKey === 'string' ? input.targetKey : '';
    validateRemotePort(input.remotePort);
    const webContentsId = Number(input.webContents?.id);
    if (!targetKey || !Number.isInteger(webContentsId)) throw new RangeError('Invalid relay dev-tunnel route.');
    const key = `${webContentsId}|${targetKey}|${input.remotePort}`;
    const existing = mappings.get(key);
    if (existing) return { localPort: existing.localPort, reused: true };
    return afterOpen({ ...input, targetKey }, key);
  }

  function close(input) {
    const webContentsId = Number(input.webContents?.id);
    const key = `${webContentsId}|${input.targetKey}|${input.remotePort}`;
    const route = mappings.get(key);
    if (!route) return { closed: false };
    closeRoute(route);
    const routes = routesByWebContents.get(webContentsId);
    routes?.delete(key);
    if (routes?.size === 0) routesByWebContents.delete(webContentsId);
    return { closed: true };
  }

  return {
    open,
    close,
    closeAll: () => {
      for (const webContentsId of [...routesByWebContents.keys()]) closeForWebContents(webContentsId);
    },
    closeForWebContents,
    connectionCount: () => [...connectionsByLocalPort.values()].reduce((sum, ports) => sum + ports.size, 0),
    mappingCount: () => mappings.size,
  };
}
