// SPDX-License-Identifier: Apache-2.0
/** One-shot request bridge for relay pairing: main owns native consent and
 * persistence, while the trusted local renderer owns the E2EE client. */
import { randomUUID } from 'node:crypto';

const MAX_PENDING = 4;
const MAX_RESULT_TEXT = 8_192;
const MAX_REQUEST_ID_ATTEMPTS = 8;

function safeString(value, max = MAX_RESULT_TEXT) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.ok === false && Object.keys(value).every((key) => key === 'ok' || key === 'error')
    && safeString(value.error, 128)) return { ok: false, error: value.error };
  if (Object.keys(value).some((key) => !['ok', 'clientToken', 'serverLabel'].includes(key))) return null;
  if (value.ok !== true || !safeString(value.clientToken)) return null;
  const serverLabel = value.serverLabel === null ? null
    : safeString(value.serverLabel, 256) ? value.serverLabel : null;
  return { ok: true, clientToken: value.clientToken, serverLabel };
}

export function createRelayPairingBridge({
  getWindow,
  timeoutMs = 20_000,
  makeRequestId = randomUUID,
  maxPending = MAX_PENDING,
} = {}) {
  if (typeof getWindow !== 'function') throw new TypeError('getWindow is required');
  const pending = new Map();

  function request(input) {
    const win = getWindow();
    if (!win || win.isDestroyed?.() || win.webContents?.isDestroyed?.()) {
      return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
    }
    if (pending.size >= maxPending) return Promise.resolve({ ok: false, error: 'too-many-pairing-requests' });
    let requestId;
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS; attempt += 1) {
      const candidate = makeRequestId();
      if (safeString(candidate, 128) && !pending.has(candidate)) {
        requestId = candidate;
        break;
      }
    }
    if (!requestId) return Promise.resolve({ ok: false, error: 'relay-pairing-request-id-unavailable' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        win.webContents.removeListener?.('destroyed', onDestroyed);
        pending.delete(requestId);
        resolve(result);
      };
      const onDestroyed = () => finish({ ok: false, error: 'renderer-unavailable' });
      const timer = setTimeout(() => finish({ ok: false, error: 'relay-pairing-timeout' }), timeoutMs);
      pending.set(requestId, { finish });
      win.webContents.once?.('destroyed', onDestroyed);
      try {
        win.webContents.send('openchamber:emit', {
          event: 'openchamber:desktop-pairing-relay-request',
          detail: { ...input, requestId },
        });
      } catch { finish({ ok: false, error: 'renderer-unavailable' }); }
    });
  }

  function complete(requestId, result) {
    if (!safeString(requestId, 128)) return { ok: false, error: 'invalid-request-id' };
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, error: 'relay-pairing-request-expired' };
    const parsed = parseResult(result);
    if (!parsed) return { ok: false, error: 'invalid-relay-pairing-result' };
    entry.finish(parsed);
    return { ok: true, result: { accepted: true } };
  }

  function closeAll() {
    for (const entry of [...pending.values()]) entry.finish({ ok: false, error: 'renderer-unavailable' });
  }

  return { request, complete, closeAll, get pendingCount() { return pending.size; } };
}
