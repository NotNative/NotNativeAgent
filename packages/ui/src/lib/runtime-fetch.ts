// SPDX-License-Identifier: Apache-2.0
/**
 * runtimeFetch (doc 01 §10.4–§10.5): the single fetch path for all UI traffic.
 *  - resolves /api|/auth|/health relative calls against the active instance origin
 *  - applies bearer + extra headers
 *  - GET coalescing HP-6: identical concurrent GETs to the allowlist share one
 *    promise; every caller receives response.clone(); the entry is dropped as
 *    soon as the request settles (never a stale cache); never for calls with an
 *    AbortSignal or a Request input, never for /event, GET only.
 *
 * The native fetch is captured at module-evaluation time, before the bridge
 * patches window.fetch, so runtimeFetch can never recurse into itself.
 */
import { applyRuntimeAuthHeaders } from './runtime-auth.ts';
import { resolveApiUrl } from './runtime-url.ts';
import { isRelayModeActive, relayFetchOrThrow } from './runtime-tunnel.ts';

const COALESCE_ALLOWLIST = /^\/api\/(config|path|app\/agents|agent|project|command)(\?|$)/;

const capturedFetch: typeof fetch | null =
  typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? (globalThis.fetch.bind(globalThis) as typeof fetch)
    : null;

const inflight = new Map<string, Promise<Response>>();

function fetchNative(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const fn = capturedFetch ?? ((i: RequestInfo, o?: RequestInit) => fetch(i, o));
  return fn(input, init);
}

type RequestInfo = Request | string;

export function shouldCoalesce(
  url: string,
  method: string,
  init?: { signal?: AbortSignal | null },
  inputIsRequest?: boolean,
): boolean {
  if (method !== 'GET') return false;
  if (inputIsRequest) return false;
  if (init?.signal) return false;
  const path = toPath(url);
  if (!path) return false;
  if (path.includes('/event')) return false;
  return COALESCE_ALLOWLIST.test(path);
}

function toPath(url: string): string | null {
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).pathname;
    return url.startsWith('/') ? url : null;
  } catch {
    return null;
  }
}

export async function runtimeFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const inputIsRequest = typeof input !== 'string';
  const raw = inputIsRequest ? (input as Request).url : (input as string);
  const url = resolveApiUrl(raw);
  const method = (init?.method ?? (inputIsRequest ? (input as Request).method : 'GET')).toUpperCase();

  const headers = new Headers(init?.headers ?? (inputIsRequest ? (input as Request).headers : undefined));
  applyRuntimeAuthHeaders(headers);

  const requestInit: RequestInit = {
    ...(inputIsRequest ? {} : (init ?? {})),
    method,
    headers,
    credentials: 'include',
  };

  if (shouldCoalesce(url, method, requestInit, inputIsRequest)) {
    const existing = inflight.get(url);
    const promise =
      existing ??
      (() => {
        const p = transportFetch(url, requestInit).finally(() => inflight.delete(url));
        inflight.set(url, p);
        return p;
      })();
    const response = await promise;
    return response.clone();
  }

  return transportFetch(url, requestInit);
}

/** Relay mode transports through the tunnel; hosted mode rides the native
 * fetch path (§3.10 runtime integration). Read coalescing applies to both. */
function transportFetch(url: string, requestInit: RequestInit): Promise<Response> {
  if (isRelayModeActive()) return relayFetchOrThrow(url, requestInit);
  return fetchNative(url, requestInit);
}

let bridgeInstalled = false;

/**
 * Web/PWA entry: patch window.fetch so every relative server path takes the
 * runtime path (doc 01 §2.1). Idempotent.
 */
export function installRuntimeFetchBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  if (typeof window === 'undefined') return;
  const native = window.fetch.bind(window);
  const patched = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const isServerRelative = /^\/(api|auth|health)(\/|\?|$)/.test(raw);
    if (!isServerRelative) return native(input as RequestInfo, init);
    return runtimeFetch(typeof input === 'string' ? input : (input as Request), init);
  };
  window.fetch = patched as typeof window.fetch;
}

export function __resetFetchBridgeForTests(): void {
  bridgeInstalled = false;
  inflight.clear();
}

export const coalescingInflightCount = (): number => inflight.size;
