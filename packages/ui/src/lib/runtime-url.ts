// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime URL resolver (doc 01 §11): every UI network call resolves against the
 * active instance origin. Harness traffic shares that origin under /api (HP-1).
 */
import { getInjectedApiBaseUrl } from './runtimeConfig.ts';

let apiBaseUrl: string | null = null;
let realtimeBaseUrl: string | null = null;

export function configureRuntimeUrlResolver(config: {
  apiBaseUrl: string;
  realtimeBaseUrl?: string;
}): void {
  apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  realtimeBaseUrl = (config.realtimeBaseUrl ?? config.apiBaseUrl).replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  if (apiBaseUrl) return apiBaseUrl;
  const injected = getInjectedApiBaseUrl();
  if (injected) return injected;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

export function getRealtimeBaseUrl(): string {
  return realtimeBaseUrl ?? getApiBaseUrl();
}

/** Resolve an API path ('/api/…', '/auth/…', '/health') against the active origin. */
export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('wss://') || pathOrUrl.startsWith('ws://')) {
    return pathOrUrl;
  }
  const base = pathOrUrl.startsWith('/api/') || pathOrUrl === '/api/event'
    ? getApiBaseUrl()
    : getApiBaseUrl();
  return `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

/** SSE/WebSocket URLs ride the realtime base + URL auth token (HP-8). */
export async function getEventStreamUrl(path = '/api/event'): Promise<string> {
  const { appendAuthTokenToUrl } = await import('./runtime-auth.ts');
  const url = `${getRealtimeBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
  return await appendAuthTokenToUrl(url);
}

export function getManifestUrl(params: { appName?: string; orientation?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.appName) query.set('appName', params.appName);
  if (params.orientation) query.set('orientation', params.orientation);
  const qs = query.toString();
  return `${getApiBaseUrl()}/manifest.webmanifest${qs ? `?${qs}` : ''}`;
}
