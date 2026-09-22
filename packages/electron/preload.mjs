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
