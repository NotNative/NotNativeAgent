// SPDX-License-Identifier: Apache-2.0

const MAX_BODY_BYTES = 64 * 1024;
const REQUIRED_CAPABILITY = 'api.runtime-url.v1';

async function readJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('response-too-large');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('invalid-json');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function baseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
  url.hash = '';
  // Host values may be copied from a browser URL with tracking or session
  // query parameters. API paths must be appended to the pathname, never to
  // the query string (and those values must not be sent to the API routes).
  url.search = '';
  return url.href.replace(/\/+$/u, '');
}

function headersFor(token, requestHeaders = {}) {
  const headers = new Headers({ accept: 'application/json' });
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (/^[a-z0-9-]{1,80}$/iu.test(name) && typeof value === 'string'
      && !['authorization', 'cookie', 'host', 'origin', 'set-cookie', 'proxy-authorization'].includes(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  if (token) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

function classifyVersion(body) {
  const compatibility = body?.compatibility;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.status !== 'ok') return 'wrong-service';
  // Older servers sometimes expose compatibility as an array. It is a known
  // version surface, but cannot prove the requested runtime-url capability.
  if (Array.isArray(compatibility)) return 'incompatible';
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) return 'wrong-service';
  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes(REQUIRED_CAPABILITY)) return 'incompatible';
  if (compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1) return 'update-recommended';
  return 'ok';
}

async function cancelResponse(response) {
  try { await response?.body?.cancel(); } catch { /* consumed, locked, or already aborted */ }
}

/** One shared deadline covers fetches and complete response-body reads. */
export async function probeElectronHostWithDeadline({
  url, timeoutMs = 2_000, clientToken, requestHeaders, expectedServerId,
  chromiumFetch, isReady = () => true,
}) {
  const startedAt = Date.now();
  let timer;
  const controller = new AbortController();
  const responses = [];
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'unreachable' });
    }, Math.max(1, timeoutMs));
  });
  const work = (async () => {
    if (!isReady() || typeof chromiumFetch !== 'function') return { status: 'unreachable' };
    let origin;
    try { origin = baseUrl(url); } catch { return { status: 'wrong-service' }; }
    if (expectedServerId) {
      try {
        const health = await chromiumFetch(`${origin}/health`, {
          method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
        });
        responses.push(health);
        if (health.status >= 300 && health.status < 400 || health.redirected) return { status: 'wrong-service' };
        if (health.ok) {
          let identity;
          try { identity = await readJson(health); }
          catch { return { status: 'wrong-service' }; }
          if (identity?.serverId !== expectedServerId) return { status: 'wrong-service' };
        }
      } catch (error) {
        if (controller.signal.aborted) return { status: 'unreachable' };
        if (/redirect.*cancel/iu.test(String(error))) return { status: 'wrong-service' };
        // Identity is an optional preflight; the authenticated version check
        // below remains authoritative when health is unavailable/older.
      }
    }
    let versionResponse;
    try {
      versionResponse = await chromiumFetch(`${origin}/api/version`, {
        method: 'GET', headers: headersFor(clientToken, requestHeaders), redirect: 'error', signal: controller.signal,
      });
      responses.push(versionResponse);
      if (versionResponse.status === 401 || versionResponse.status === 403) return { status: 'auth' };
      if (!versionResponse.ok) return { status: 'unreachable' };
      let version;
      try { version = await readJson(versionResponse); }
      catch { return { status: 'wrong-service' }; }
      const status = classifyVersion(version);
      if (status !== 'ok') return { status };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'unreachable' };
      if (/redirect.*cancel/iu.test(String(error))) return { status: 'wrong-service' };
      return { status: 'unreachable' };
    }
    let sessionResponse;
    try {
      sessionResponse = await chromiumFetch(`${origin}/auth/session`, {
        method: 'GET', headers: headersFor(clientToken, requestHeaders), redirect: 'error', signal: controller.signal,
      });
      responses.push(sessionResponse);
      if (sessionResponse.status === 401 || sessionResponse.status === 403) return { status: 'auth' };
      if (!sessionResponse.ok) return { status: 'unreachable' };
      return { status: 'ok' };
    } catch { return { status: 'unreachable' }; }
  })();
  try {
    const result = await Promise.race([work, deadline]);
    return { ...result, latencyMs: Math.max(0, Date.now() - startedAt) };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await Promise.all(responses.map(cancelResponse));
  }
}

export async function probeDesktopHost(options) {
  const first = await probeElectronHostWithDeadline({ ...options, timeoutMs: 2_000 });
  if (first.status !== 'unreachable') return first;
  return probeElectronHostWithDeadline({ ...options, timeoutMs: 10_000 });
}
