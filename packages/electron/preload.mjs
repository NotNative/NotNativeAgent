// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop preload (P12a v1, D-09-3): the minimal desktop invoke
 * face. contextIsolation keeps this the ONLY bridge; the main process
 * enforces the command allowlist + sender framing (§11.1 v1), so a
 * compromised renderer page can never escalate through this promise map.
 *
 * Contract: __NOTNATIVE_DESKTOP_INVOKE__(command, payload) resolves to
 *   { ok: true, result }   — success (result is command-shaped)
 *   { ok: false, error }   — rejection (unknown command, bad sender,
 *                            invalid url, timeout) — never a raw throw.
 */
import { contextBridge, ipcRenderer } from 'electron';

// Available before the web app's first script executes. The main process
// no longer races React boot with a dom-ready identity injection.
contextBridge.exposeInMainWorld('__NOTNATIVE_ELECTRON__', Object.freeze({
  runtime: 'electron', arch: process.arch, trayEnabled: false,
}));

const REPLY_CHANNEL = 'nnd:desktop-reply';
const INVOKE_TIMEOUT_MS = 10_000;

const pending = new Map();
let sequence = 0;

ipcRenderer.on(REPLY_CHANNEL, (_event, envelope) => {
  const seq = envelope && typeof envelope.seq === 'number' ? envelope.seq : -1;
  const waiter = pending.get(seq);
  if (!waiter) return;
  pending.delete(seq);
  clearTimeout(waiter.timer);
  const { seq: _drop, ...result } = envelope ?? { ok: false, error: 'malformed-reply' };
  waiter.resolve(result);
});

function invoke(command, payload) {
  return new Promise((resolve) => {
    sequence += 1;
    const seq = sequence;
    const timeoutMs = command === 'desktop_updater_download' ? 30 * 60_000
      : command === 'desktop_updater_install' ? 30_000
      : command === 'desktop_retry_server' ? 25_000 : INVOKE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(seq);
      resolve({ ok: false, error: 'invoke-timeout' });
    }, timeoutMs);
    pending.set(seq, { resolve, timer });
    try {
      ipcRenderer.send('nnd:desktop-invoke', { command, payload, seq });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(seq);
      resolve({ ok: false, error: String(error?.message ?? error) });
    }
  });
}

contextBridge.exposeInMainWorld('__NOTNATIVE_DESKTOP_INVOKE__', async (command, payload) => {
  try {
    return await invoke(command, payload);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
});

contextBridge.exposeInMainWorld('__NOTNATIVE_DESKTOP_UPDATER__', Object.freeze({
  check: () => invoke('desktop_updater_check'),
  download: () => invoke('desktop_updater_download'),
  install: () => invoke('desktop_updater_install'),
  onProgress(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, envelope) => {
      if (envelope?.event === 'openchamber:update-progress' && envelope.detail && typeof envelope.detail.event === 'string') handler(envelope.detail);
    };
    ipcRenderer.on('openchamber:emit', listener);
    return () => ipcRenderer.removeListener('openchamber:emit', listener);
  },
}));

contextBridge.exposeInMainWorld('__NOTNATIVE_DESKTOP_EVENTS__', Object.freeze({
  onOpenSession(handler) {
    if (typeof handler !== 'function') return () => {};
    openSessionHandlers.add(handler);
    for (const detail of pendingOpenSessions.splice(0)) handler(detail);
    return () => openSessionHandlers.delete(handler);
  },
  onRelayPairingRequest(handler) {
    if (typeof handler !== 'function') return () => {};
    relayPairingHandlers.add(handler);
    for (const detail of pendingRelayPairingRequests.splice(0)) handler(detail);
    return () => relayPairingHandlers.delete(handler);
  },
  onSshStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    sshStatusHandlers.add(handler);
    for (const detail of pendingSshStatuses.splice(0)) handler(detail);
    return () => sshStatusHandlers.delete(handler);
  },
}));

// The main process can route a notification click immediately after document
// load, before React installs its event subscription. Buffer a small number
// until then so the click isn't lost during a cold start.
const openSessionHandlers = new Set();
const pendingOpenSessions = [];
const relayPairingHandlers = new Set();
const pendingRelayPairingRequests = [];
const sshStatusHandlers = new Set();
const pendingSshStatuses = [];
const sshStatusPhases = new Set([
  'idle', 'config_resolved', 'auth_check', 'master_connecting', 'remote_probe',
  'installing', 'updating', 'server_detecting', 'server_starting', 'forwarding',
  'ready', 'degraded', 'error',
]);
ipcRenderer.on('openchamber:emit', (_event, envelope) => {
  const detail = envelope?.detail;
  if (envelope?.event === 'openchamber:open-session') {
    if (!detail || typeof detail.sessionId !== 'string' || detail.sessionId.length > 500) return;
    const safe = { sessionId: detail.sessionId, ...(typeof detail.directory === 'string' ? { directory: detail.directory.slice(0, 2_000) } : {}) };
    if (openSessionHandlers.size) for (const handler of openSessionHandlers) handler(safe);
    else {
      pendingOpenSessions.push(safe);
      if (pendingOpenSessions.length > 20) pendingOpenSessions.shift();
    }
    return;
  }
  if (envelope?.event === 'openchamber:ssh-instance-status') {
    if (!detail || typeof detail.id !== 'string' || detail.id.length > 128
      || !sshStatusPhases.has(detail.phase)) return;
    const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65_535;
    const safe = {
      id: detail.id,
      phase: detail.phase,
      ...(typeof detail.detail === 'string' ? { detail: detail.detail.slice(0, 1_000) } : {}),
      ...(typeof detail.localUrl === 'string' ? { localUrl: detail.localUrl.slice(0, 2_000) } : {}),
      ...(validPort(detail.localPort) ? { localPort: detail.localPort } : {}),
      ...(validPort(detail.remotePort) ? { remotePort: detail.remotePort } : {}),
      startedByUs: detail.startedByUs === true,
      retryAttempt: Number.isFinite(detail.retryAttempt) ? Math.max(0, Math.floor(detail.retryAttempt)) : 0,
      requiresUserAction: detail.requiresUserAction === true,
      updatedAtMs: Number.isFinite(detail.updatedAtMs) ? detail.updatedAtMs : Date.now(),
    };
    if (sshStatusHandlers.size) for (const handler of sshStatusHandlers) handler(safe);
    else {
      pendingSshStatuses.push(safe);
      if (pendingSshStatuses.length > 100) pendingSshStatuses.shift();
    }
    return;
  }
  if (envelope?.event !== 'openchamber:desktop-pairing-relay-request' || !detail
    || typeof detail.requestId !== 'string' || detail.requestId.length > 128
    || !detail.payload || typeof detail.payload !== 'object'
    || !detail.candidate || typeof detail.candidate !== 'object') return;
  if (relayPairingHandlers.size) for (const handler of relayPairingHandlers) handler(detail);
  else {
    pendingRelayPairingRequests.push(detail);
    if (pendingRelayPairingRequests.length > 4) pendingRelayPairingRequests.shift();
  }
});

contextBridge.exposeInMainWorld('__NOTNATIVE_RELAY_DEV_TUNNEL__', Object.freeze({
  open: (payload) => invoke('desktop_dev_tunnel_open', payload),
  close: (payload) => invoke('desktop_dev_tunnel_close', payload),
  closeAll: () => invoke('desktop_relay_dev_tunnel_close_all'),
  onConnect(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (event) => {
      const payload = event.data;
      if (payload?.type !== 'connect') return;
      const port = event.ports?.[0];
      if (port) handler({ ...payload, port });
    };
    ipcRenderer.on('openchamber:relay-dev-tunnel-connect', listener);
    return () => ipcRenderer.removeListener('openchamber:relay-dev-tunnel-connect', listener);
  },
}));

// The isolated guest has no preload. Only the top-level NND renderer receives
// this narrow browser-control face; main derives ownership from its sender.
contextBridge.exposeInMainWorld('__NOTNATIVE_BROWSER_CONTROL__', Object.freeze({
  register: () => invoke('desktop_browser_register'),
  unregister: () => invoke('desktop_browser_unregister'),
  claim: (requestId) => invoke('desktop_browser_claim', { requestId }),
  result: (requestId, result) => invoke('desktop_browser_result', { requestId, result }),
  onRequest(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, request) => {
      if (request && typeof request.requestId === 'string' && typeof request.action === 'string') handler(request);
    };
    ipcRenderer.on('nnd:browser-request', listener);
    return () => ipcRenderer.removeListener('nnd:browser-request', listener);
  },
}));
