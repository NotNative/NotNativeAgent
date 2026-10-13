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
import { isRelayModeActive, relayFetchOrThrow } from './runtime-tunnel.ts';

let bearerToken: string | null | undefined = undefined; // undefined = not yet initialized
let extraHeaders: Record<string, string> | null | undefined = undefined;
let credentialGeneration = 0;

export function initializeRuntimeCredentials(): void {
  bearerToken = getInjectedClientToken() ?? null;
  extraHeaders = getInjectedRuntimeHeaders();
  clearCachedUrlAuthToken();
}

export function setRuntimeBearerToken(token: string | null): void {
  bearerToken = token;
  clearCachedUrlAuthToken();
}

export function setRuntimeExtraHeaders(headers: Record<string, string>): void {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') safe[key] = value;
  }
  extraHeaders = safe;
  clearCachedUrlAuthToken();
}

export function applyRuntimeAuthHeaders(headers: Headers): Headers {
  // Invariant: explicit logout overrides a read-only desktop injection.
  const token = bearerToken === undefined ? getInjectedClientToken() ?? null : bearerToken;
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  const extras = extraHeaders ?? getInjectedRuntimeHeaders();
  for (const [key, value] of Object.entries(extras)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

// ── URL tokens (HP-8) ───────────────────────────────────────────────────────
type UrlTokenState = { token: string; expiresAt: number } | null;
export interface UrlTokenContext { generation: number; token: string | null }
let urlToken: UrlTokenState = null;
let activeConsumers = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const URL_TOKEN_MINT_TIMEOUT_MS = 30_000;

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

async function mintUrlToken(callerSignal?: AbortSignal): Promise<void> {
  const generation = credentialGeneration;
  const priorToken = urlToken;
  const clearIfCurrent = (): void => {
    if (generation === credentialGeneration && urlToken === priorToken) urlToken = null;
  };
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(URL_TOKEN_MINT_TIMEOUT_MS)])
    : AbortSignal.timeout(URL_TOKEN_MINT_TIMEOUT_MS);
  try {
    // In relay mode the mint rides the tunnel (§3.10): there is no
    // reachable network base URL, and response classification is unchanged.
    const response = await awaitAbort(isRelayModeActive()
      ? relayFetchOrThrow(`${getApiBaseUrl()}/auth/url-token`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: applyRuntimeAuthHeaders(new Headers({ 'content-type': 'application/json' })),
      })
      : fetch(`${getApiBaseUrl()}/auth/url-token`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: applyRuntimeAuthHeaders(new Headers({ 'content-type': 'application/json' })),
      }), signal);
    if (!response.ok) { clearIfCurrent(); return; } // §2.6: a failed mint cannot erase a newer token
    const body = (await awaitAbort(response.json().catch(() => null), signal)) as { token?: string; expiresAt?: string } | null;
    if (!body?.token || !body.expiresAt) { clearIfCurrent(); return; }
    if (generation !== credentialGeneration) return; // superseded by a credential change
    urlToken = { token: body.token, expiresAt: new Date(body.expiresAt).getTime() };
    scheduleRefresh();
  } catch {
    clearIfCurrent(); // An aborted/failed older mint cannot clear another consumer's fresh token.
  }
}

function awaitAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
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
export async function appendAuthTokenToUrl(url: string, signal?: AbortSignal): Promise<string> {
  return (await appendAuthTokenToUrlWithContext(url, signal)).url;
}

export async function appendAuthTokenToUrlWithContext(url: string, signal?: AbortSignal): Promise<{
  url: string; context: UrlTokenContext;
}> {
  if (signal?.aborted) throw signal.reason;
  const generation = credentialGeneration;
  if (!urlToken) await mintUrlToken(signal);
  if (signal?.aborted) throw signal.reason;
  if (generation !== credentialGeneration) throw new Error('url_token_context_changed');
  const token = urlToken?.token ?? null;
  const context = { generation, token };
  if (!token) return { url, context };
  const separator = url.includes('?') ? '&' : '?';
  return { url: `${url}${separator}nn_url_token=${encodeURIComponent(token)}`, context };
}

export function getCurrentUrlToken(): string | null {
  return urlToken?.token ?? null;
}

export function getUrlTokenContext(): UrlTokenContext {
  return { generation: credentialGeneration, token: getCurrentUrlToken() };
}

export function clearCachedUrlAuthTokenIfCurrent(context: UrlTokenContext): void {
  if (context.token && context.generation === credentialGeneration && context.token === getCurrentUrlToken()) {
    clearCachedUrlAuthToken();
  }
}

/** WS closed before `ready`: the token is being replayed against a server that
 * will not accept it — drop it so reconnects do not storm (doc 04 §D.1). */
export function clearCachedUrlAuthToken(): void {
  credentialGeneration += 1;
  urlToken = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
