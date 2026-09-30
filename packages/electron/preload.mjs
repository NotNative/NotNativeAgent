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
    const timer = setTimeout(() => {
      pending.delete(seq);
      resolve({ ok: false, error: 'invoke-timeout' });
    }, INVOKE_TIMEOUT_MS);
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
