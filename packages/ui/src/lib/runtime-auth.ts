// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime auth (doc 01 HP-8/HP-10):
 *  - bearer token + extra headers applied to runtimeFetch traffic
 *  - URL-token lifecycle for streams/assets that cannot carry headers:
 *    POST /auth/url-token → {token,expiresAt}; atomic swap; proactive refresh at
 *    expiresAt − 10s − 5s while consumers are active; generation bump on
 *    credential changes invalidates in-flight mints.
 */
import { getInjectedClientToken, getInjectedRuntimeHeaders } from './runtimeConfig.ts';
import { getApiBaseUrl } from './runtime-url.ts';

let bearerToken: string | null | undefined = undefined; // undefined = not yet initialized
let extraHeaders: Record<string, string> | null | undefined = undefined;
let credentialGeneration = 0;

export function initializeRuntimeCredentials(): void {
  bearerToken = getInjectedClientToken() ?? null;
  extraHeaders = getInjectedRuntimeHeaders();
}

export function setRuntimeBearerToken(token: string | null): void {
  bearerToken = token;
  credentialGeneration += 1; // invalidates in-flight URL-token mints
}

export function setRuntimeExtraHeaders(headers: Record<string, string>): void {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') safe[key] = value;
  }
  extraHeaders = safe;
  credentialGeneration += 1;
}

export function applyRuntimeAuthHeaders(headers: Headers): Headers {
  const token = bearerToken ?? getInjectedClientToken() ?? null;
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  const extras = extraHeaders ?? getInjectedRuntimeHeaders();
  for (const [key, value] of Object.entries(extras)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

// ── URL tokens (HP-8) ───────────────────────────────────────────────────────
type UrlTokenState = { token: string; expiresAt: number } | null;
let urlToken: UrlTokenState = null;
let activeConsumers = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function acquireRuntimeUrlAuthToken(): () => void {
  activeConsumers += 1;
  void refreshRuntimeUrlAuthToken();
  scheduleRefresh();
  return () => {
    activeConsumers = Math.max(0, activeConsumers - 1);
    if (activeConsumers === 0 && refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };
}

async function mintUrlToken(): Promise<void> {
  const generation = credentialGeneration;
  try {
    const response = await fetch(`${getApiBaseUrl()}/auth/url-token`, {
      method: 'POST',
      credentials: 'include',
      headers: applyRuntimeAuthHeaders(new Headers({ 'content-type': 'application/json' })),
    });
    if (!response.ok) return;
    const body = (await response.json().catch(() => null)) as { token?: string; expiresAt?: string } | null;
    if (!body?.token || !body.expiresAt) return;
    if (generation !== credentialGeneration) return; // superseded by a credential change
    urlToken = { token: body.token, expiresAt: new Date(body.expiresAt).getTime() };
    scheduleRefresh();
  } catch {
    /* prompt retry rides on the next acquire; token absence is not fatal */
  }
}

export async function refreshRuntimeUrlAuthToken(apiBaseUrl?: string): Promise<void> {
  void apiBaseUrl;
  await mintUrlToken();
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!urlToken || activeConsumers === 0) return;
  const refreshAt = urlToken.expiresAt - 10_000 - 5_000;
  const delay = Math.max(1_000, refreshAt - Date.now());
  refreshTimer = setTimeout(() => {
    void mintUrlToken();
  }, delay);
  if (typeof (refreshTimer as unknown as { unref?: () => void }).unref === 'function') {
    (refreshTimer as unknown as { unref: () => void }).unref();
  }
}

/** Appends ?nn_url_token= when a token is available (streams, assets, images). */
export async function appendAuthTokenToUrl(url: string): Promise<string> {
  if (!urlToken) await mintUrlToken();
  if (!urlToken) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}nn_url_token=${encodeURIComponent(urlToken.token)}`;
}

export function getCurrentUrlToken(): string | null {
  return urlToken?.token ?? null;
}

/** WS closed before `ready`: the token is being replayed against a server that
 * will not accept it — drop it so reconnects do not storm (doc 04 §D.1). */
export function clearCachedUrlAuthToken(): void {
  urlToken = null;
}
