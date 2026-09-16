// SPDX-License-Identifier: Apache-2.0
/**
 * Access to the injected "who am I" window globals (doc 01 §3.1).
 * Absence has meaning; never invent defaults here — consumers decide.
 */

export function getInjectedApiBaseUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = window.__NOTNATIVE_API_BASE_URL__;
  return typeof v === 'string' && v ? v.replace(/\/+$/, '') : undefined;
}

export function getInjectedClientToken(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.__NOTNATIVE_CLIENT_TOKEN__;
}

export function getInjectedRuntimeHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const headers = window.__NOTNATIVE_RUNTIME_HEADERS__;
  if (!headers || typeof headers !== 'object') return {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') continue; // never Authorization
    if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}

export function getInjectedLocalOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = window.__NOTNATIVE_LOCAL_ORIGIN__;
  return typeof v === 'string' && v ? v.replace(/\/+$/, '') : undefined;
}

export function getInjectedRelayHostId(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.__NOTNATIVE_RELAY_HOST_ID__;
}

export function getSurfaceStamp(): 'desktop' | 'mobile' | undefined {
  return typeof window === 'undefined' ? undefined : window.__NOTNATIVE_SURFACE__;
}

/**
 * contextBridge globals are read-only in Electron (P12): writes may throw
 * silently-swallowed errors; in-memory state stays authoritative either way.
 */
export function writeWindowGlobal(name: string, value: unknown): void {
  try {
    (window as unknown as Record<string, unknown>)[name] = value;
  } catch {
    /* read-only injection — keep in-memory state authoritative */
  }
}
