// SPDX-License-Identifier: Apache-2.0
/**
 * Direct dev-tunnel client (doc 13 §H.5). Electron imports this native module
 * dynamically because the web package already owns the ws client dependency.
 * The native-JS seam keeps the Electron runtime from importing server TS.
 * Local sockets are paused during the WebSocket handshake and their bytes are
 * bounded by the 256 KiB pending cap; overflow destroys only that connection.
 */
import { createServer } from 'node:net';
import { WebSocket } from 'ws';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024;
const OPEN_READY_STATE = 1;

/**
 * @typedef {import('ws').WebSocket} TunnelWebSocket
 * @typedef {{ baseUrl: string, port: number, clientToken?: string | null, requestHeaders?: Record<string, string> }} TunnelOpenInput
 * @typedef {{ baseUrl: string, port: number }} TunnelCloseInput
 * @typedef {{ localPort: number, reused: boolean, url: string }} TunnelOpenResult
 * @typedef {{ bytes: number, chunks: Buffer[] }} PendingBytes
 * @typedef {import('ws').WebSocket | null} SocketStateWebSocket
 * @typedef {{ source: import('node:net').Socket, socket: SocketStateWebSocket, pending: PendingBytes }} SourceState
 */
/** @typedef {object} TunnelMapping
 * @property {number} requestedPort
 * @property {number} localPort
 * @property {import('node:net').Server} server
 * @property {Set<SourceState>} sources
 */
/**
 * @typedef {object} DevTunnelClientOptions
 * @property {number} [handshakeTimeoutMs]
 * @property {number} [maxPendingBytes]
 * @property {(port: number, error: Error) => void} [onListenerError]
 * @property {(url: URL, headers: Record<string, string>) => TunnelWebSocket} [connectWebSocket]
 */

function shutdownWebSocket(socket) {
  try { socket.terminate?.(); } catch { socket.close?.(); }
}

/** @param {string} baseUrl */
export function toWebSocketUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RangeError('Dev tunnel base URL must use http or https.');
  }
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
  return parsed;
}

/** @param {unknown} port */
export function validateTunnelPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('Dev tunnel port must be between 1 and 65535.');
  }
}

/** @param {Buffer} chunk */
function asBuffer(chunk) {
  return Array.isArray(chunk) ? Buffer.concat(chunk) : Buffer.from(chunk);
}

/** @param {TunnelWebSocket} socket */
function isOpen(socket) { return socket.readyState === OPEN_READY_STATE; }

/** @param {URL} url @param {Record<string, string>} headers */
function connectWebSocket(url, headers) {
  return new WebSocket(url, { headers });
}

/**
 * @param {TunnelWebSocket} socket
 * @param {number} timeoutMs
 */
function waitForHandshake(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      socket.off('open', settle);
      socket.off('close', settle);
      socket.off('error', settle);
    };
    const settle = () => {
      finish();
      if (isOpen(socket)) resolve();
      else reject(new Error('Dev tunnel WebSocket handshake failed.'));
    };
    const timer = setTimeout(() => {
      finish();
      shutdownWebSocket(socket);
      reject(new Error(`Dev tunnel WebSocket handshake timed out after ${timeoutMs} milliseconds.`));
    }, timeoutMs);
    socket.once('open', settle);
    socket.once('close', settle);
    socket.once('error', settle);
  });
}

/**
 * @param {SourceState} state
 */
function destroySource(state) {
  state.source.destroy();
}

/**
 * @param {import('node:net').Server} server
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    const succeed = () => { server.off('error', fail); resolve(); };
    const fail = (error) => { server.off('listening', succeed); reject(error); };
    server.once('error', fail);
    server.once('listening', succeed);
    server.listen(0, '127.0.0.1');
  });
}

/**
 * @param {SourceState} state
 * @param {TunnelWebSocket} socket
 */
function activateSource(state, socket) {
  state.socket = socket;
  if (state.pending.chunks.length > 0) socket.send(Buffer.concat(state.pending.chunks), { binary: true });
  state.pending.bytes = 0;
  state.pending.chunks = [];
  state.source.resume();
}

/**
 * @param {DevTunnelClientOptions} [options]
 */
export function createDevTunnelClient(options = {}) {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  /** @type {Map<string, Promise<TunnelOpenResult>>} */
  const opens = new Map();
  /** @type {Map<string, TunnelMapping>} */
  const mappings = new Map();

  /** @param {TunnelMapping} mapping */
  function closeMapping(mapping) {
    for (const state of [...mapping.sources]) destroySource(state);
    mapping.sources.clear();
    if (!mapping.server.closed) mapping.server.close();
    mappings.forEach((entry, key) => { if (entry === mapping) mappings.delete(key); });
  }

  const cloneForReuse = (result) => ({ ...result, reused: true });

  /** @param {string} key */
  const closeKey = (key) => {
    const mapping = mappings.get(key);
    if (!mapping) return false;
    closeMapping(mapping);
    return true;
  };

  const closeAll = () => { for (const key of [...mappings.keys()]) closeKey(key); };

  /**
   * @param {TunnelOpenInput} input
   * @returns {Promise<TunnelOpenResult>}
   */
  async function open(input) {
    validateTunnelPort(input.port);
    const key = `${input.baseUrl}|${input.port}`;
    const mapping = mappings.get(key);
    if (mapping) return { localPort: mapping.localPort, reused: true, url: `http://127.0.0.1:${mapping.localPort}/` };
    const pendingOpen = opens.get(key);
    if (pendingOpen) {
      return cloneForReuse(await pendingOpen);
    }
    const result = establishConnection(input, key);
    opens.set(key, result);
    try { return await result; }
    finally { opens.delete(key); }
  }

  /**
   * @param {TunnelOpenInput} input
   * @param {string} key
   * @returns {Promise<TunnelOpenResult>}
   */
  async function establishConnection(input, key) {
    const serverUrl = toWebSocketUrl(input.baseUrl);
    serverUrl.pathname = '/api/dev-tunnel';
    serverUrl.search = `?port=${input.port}`;
    const headers = { ...(input.clientToken ? { authorization: `Bearer ${input.clientToken}` } : {}), ...input.requestHeaders };
    const server = createServer((source) => {
      const mapping = mappings.get(key);
      if (!mapping) { source.destroy(); return; }
      void openSourceConnection(mapping, source, serverUrl, headers);
    });
    server.on('error', (error) => {
      options.onListenerError?.(input.port, error);
      const mapping = mappings.get(key);
      if (mapping) closeMapping(mapping);
    });
    await listen(server);
    const mapping = makeMapping(input.baseUrl, input.port, server);
    mappings.set(key, mapping);
    return { localPort: mapping.localPort, reused: false, url: `http://127.0.0.1:${mapping.localPort}/` };
  }

  /**
   * @param {string} baseUrl
   * @param {number} requestedPort
   * @param {import('node:net').Server} server
   */
  function makeMapping(baseUrl, requestedPort, server) {
    const mapping = {
      baseUrl,
      requestedPort,
      localPort: server.address().port,
      server,
      sources: new Set(),
    };
    return mapping;
  }

  /**
   * @param {TunnelMapping} mapping
   * @param {import('node:net').Socket} source
   * @param {URL} socketUrl
   * @param {Record<string, string>} headers
   */
  async function openSourceConnection(mapping, source, socketUrl, headers) {
    const state = { source, socket: null, pending: { bytes: 0, chunks: [] } };
    mapping.sources.add(state);
    let handshakeSocket = null;
    source.pause();
    source.once('close', () => {
      mapping.sources.delete(state);
      shutdownWebSocket(state.socket ?? handshakeSocket);
    });
    source.once('error', () => source.destroy());
    const readPending = () => {
      for (;;) {
        const chunk = source.read();
        if (chunk === null) return;
        const socket = state.socket;
        if (socket && isOpen(socket)) socket.send(asBuffer(chunk), { binary: true });
        else if (state.pending.bytes + chunk.byteLength > maxPendingBytes) { source.destroy(); return; }
        state.pending.bytes += chunk.byteLength;
        state.pending.chunks.push(chunk);
      }
    };
    source.on('readable', readPending);
    try {
      const socket = options.connectWebSocket ? options.connectWebSocket(socketUrl, headers) : connectWebSocket(socketUrl, headers);
      handshakeSocket = socket;
      await waitForHandshake(socket, handshakeTimeoutMs);
      state.socket = socket;
      socket.once('message', (chunk) => { if (state.source.writable) state.source.write(asBuffer(chunk)); });
      const finish = () => { destroySource(state); if (state.socket === socket) state.socket = null; };
      socket.once('close', finish);
      socket.once('error', finish);
      activateSource(state, socket);
    } catch {
      shutdownWebSocket(options.connectWebSocket && handshakeSocket ? handshakeSocket : null);
      destroySource(state);
    }
  }

  return { open, close: (input) => ({ closed: closeKey(`${input.baseUrl}|${input.port}`) }), closeAll, mappingCount: () => mappings.size };
}
