// SPDX-License-Identifier: Apache-2.0

const MAX_RESPONSE_BYTES = 64 * 1024;
const LOGIN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 8_192;

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-login-target');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/u, '');
}

function responseCookies(headers) {
  const values = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers?.get?.('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=[^;,]*)/u);
  return values.map((value) => value.split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('login-response-too-large');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('invalid-login-response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('login-response-too-large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function loginIdentity(runtimeKey, installId, platform, appVersion) {
  const local = runtimeKey === 'local';
  return {
    clientLabel: 'NotNativeDesktop',
    clientKind: local ? 'desktop-local' : 'desktop',
    dedupeKey: local ? 'desktop-local' : `desktop:${installId}`,
    devicePlatform: platform,
    appVersion,
  };
}

function failure(status, error) {
  return { ok: false, status, locked: status === 429, tunnelLocked: status === 403, retryAfterSeconds: null, clientToken: null, ...(error ? { error } : {}) };
}

/** Resolve the target from native state, issue a device token, and persist it. */
export function createDesktopPasswordLogin({
  getHosts,
  writeHosts,
  getLocalOrigin,
  getInstallId,
  getAppVersion,
  getPlatform,
  isCatalogBusy = () => false,
  fetchImpl = globalThis.fetch,
  timeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  if (typeof getHosts !== 'function' || typeof writeHosts !== 'function'
    || typeof getLocalOrigin !== 'function' || typeof getInstallId !== 'function'
    || typeof getAppVersion !== 'function' || typeof getPlatform !== 'function') {
    throw new TypeError('desktop password login dependencies are required');
  }

  return async function login({ runtimeKey, password, trustDevice } = {}) {
    if (typeof runtimeKey !== 'string' || runtimeKey.length > 256
      || typeof password !== 'string' || password.length === 0 || password.length > 4_096
      || typeof trustDevice !== 'boolean' || typeof fetchImpl !== 'function') return failure(400, 'invalid-login-request');
    if (isCatalogBusy()) return failure(409, 'host-catalog-busy');

    let hostId = null;
    let target;
    let config;
    try {
      config = getHosts();
      if (runtimeKey === 'local') {
        target = normalizeBaseUrl(getLocalOrigin());
      } else {
        const match = /^(?:host|ssh):([A-Za-z0-9_-]{1,128})$/u.exec(runtimeKey);
        if (!match) return failure(400, 'invalid-login-runtime');
        hostId = match[1];
        const host = config.hosts.find((item) => item.id === hostId);
        if (!host || !host.apiUrl && !host.url || host.url.startsWith('relay://')) return failure(404, 'login-host-unavailable');
        target = normalizeBaseUrl(host.apiUrl || host.url);
      }
    } catch { return failure(400, 'login-host-unavailable'); }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const identity = loginIdentity(runtimeKey, getInstallId(), getPlatform(), getAppVersion());
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (hostId) {
        const host = config.hosts.find((item) => item.id === hostId);
        for (const [name, value] of Object.entries(host?.requestHeaders ?? {})) {
          if (name.toLowerCase() !== 'accept' && name.toLowerCase() !== 'content-type') headers[name] = value;
        }
      }
      const response = await fetchImpl(`${target}/auth/session`, {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ password, trustDevice, issueClientToken: true, ...identity }),
      });
      if (!response.ok) return failure(response.status);
      let body;
      try { body = await readJson(response); }
      catch { return failure(502, 'invalid-login-response'); }
      if (body?.authenticated !== true) return failure(502, 'invalid-login-response');
      let token = typeof body?.clientToken === 'string' && body.clientToken.length <= MAX_TOKEN_LENGTH
        && body.clientToken.trim() === body.clientToken
        && !/[\u0000-\u001f\u007f]/u.test(body.clientToken) ? body.clientToken : '';
      if (!token) {
        const cookie = responseCookies(response.headers);
        if (!cookie) return failure(502, 'client-token-not-issued');
        const clients = await fetchImpl(`${target}/api/client-auth/clients`, {
          method: 'POST', headers: { ...headers, cookie }, redirect: 'error', signal: controller.signal,
          body: JSON.stringify({ label: identity.clientLabel, ...identity }),
        });
        if (!clients.ok) return failure(clients.status, 'client-token-not-issued');
        let clientBody;
        try { clientBody = await readJson(clients); }
        catch { return failure(502, 'invalid-client-token-response'); }
        token = typeof clientBody?.token === 'string' && clientBody.token.length <= MAX_TOKEN_LENGTH
          && clientBody.token.trim() === clientBody.token
          && !/[\u0000-\u001f\u007f]/u.test(clientBody.token) ? clientBody.token : '';
      }
      if (!token) return failure(502, 'client-token-not-issued');

      const latestConfig = getHosts();
      if (isCatalogBusy()) return failure(409, 'host-catalog-busy');
      if (hostId) {
        const initialHost = config.hosts.find((host) => host.id === hostId);
        const latestHost = latestConfig.hosts.find((host) => host.id === hostId);
        if (!latestHost || latestHost.url !== initialHost.url || latestHost.apiUrl !== initialHost.apiUrl
          || JSON.stringify(latestHost.requestHeaders ?? {}) !== JSON.stringify(initialHost.requestHeaders ?? {})) {
          return failure(409, 'login-host-changed');
        }
        const hosts = latestConfig.hosts.map((host) => host.id === hostId ? { ...host, clientToken: token } : host);
        const saved = writeHosts({ ...latestConfig, hosts });
        if (saved === false || saved?.ok === false) return failure(409, 'host-catalog-busy');
      } else {
        const saved = writeHosts({ ...latestConfig, localClientToken: token });
        if (saved === false || saved?.ok === false) return failure(409, 'host-catalog-busy');
      }
      return { ok: true, status: response.status, locked: false, tunnelLocked: false, retryAfterSeconds: null, clientToken: token };
    } catch (error) {
      return failure(0, controller.signal.aborted ? 'login-timeout' : 'login-failed');
    } finally { clearTimeout(timer); }
  };
}
