/**
 * Runtime endpoint / instance switching (doc 01 §11.1).
 * Keys: `local` | `host:<id>` | `url:<origin>` | sentinel `mobile-disconnected`
 * | `url:default` (uninitialized). Transient keys are forbidden persistence
 * namespaces (§16.7).
 */
import { writeWindowGlobal } from './runtimeConfig.ts';

export const DEFAULT_RUNTIME_KEY = 'url:default';
export const MOBILE_DISCONNECTED_RUNTIME_KEY = 'mobile-disconnected';

export interface RuntimeEndpointChangedDetail {
  apiBaseUrl: string;
  previousApiBaseUrl: string | null;
  runtimeKey: string;
  previousRuntimeKey: string;
}

let activeApiBaseUrl: string | null = null;
let activeRuntimeKey = DEFAULT_RUNTIME_KEY;

export function deriveRuntimeKey(apiBaseUrl: string): string {
  try {
    const origin = new URL(apiBaseUrl).origin;
    const localOrigin =
      typeof window !== 'undefined' ? window.__NOTNATIVE_LOCAL_ORIGIN__?.replace(/\/+$/, '') : undefined;
    if (localOrigin && origin === new URL(localOrigin).origin) return 'local';
    return `url:${origin}`;
  } catch {
    return DEFAULT_RUNTIME_KEY;
  }
}

export function isTransientRuntimeKey(key: string | null | undefined): boolean {
  return !key || key === DEFAULT_RUNTIME_KEY || key === MOBILE_DISCONNECTED_RUNTIME_KEY;
}

export function getApiBaseUrlActive(): string | null {
  return activeApiBaseUrl;
}

export function getRuntimeKey(): string {
  return activeRuntimeKey;
}

export function initializeRuntimeEndpoint(config: { apiBaseUrl: string; runtimeKey?: string }): void {
  if (activeApiBaseUrl) return; // one-shot; ignores repeats
  activeApiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  activeRuntimeKey = config.runtimeKey ?? deriveRuntimeKey(activeApiBaseUrl);
}

export interface SwitchRuntimeEndpointOptions {
  apiBaseUrl: string;
  clientToken?: string | null;
  runtimeKey?: string;
  requestHeaders?: Record<string, string>;
  // relay?: descriptor — lands with doc 08 (P11); must activate before token mint
}

type Listener = (detail: RuntimeEndpointChangedDetail) => void;
const listeners = new Set<Listener>();

export function onRuntimeEndpointChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function switchRuntimeEndpoint(options: SwitchRuntimeEndpointOptions): Promise<void> {
  const { configureRuntimeUrlResolver } = await import('./runtime-url.ts');
  const { setRuntimeBearerToken, setRuntimeExtraHeaders, refreshRuntimeUrlAuthToken } = await import(
    './runtime-auth.ts',
  );

  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  const runtimeKey = options.runtimeKey ?? deriveRuntimeKey(apiBaseUrl);
  const detail: RuntimeEndpointChangedDetail = {
    apiBaseUrl,
    previousApiBaseUrl: activeApiBaseUrl,
    runtimeKey,
    previousRuntimeKey: activeRuntimeKey,
  };

  dispatch('notnative:runtime-endpoint-will-change', detail);

  // 1. in-memory values (authoritative), then best-effort globals (may be read-only)
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = runtimeKey;
  writeWindowGlobal('__NOTNATIVE_API_BASE_URL__', apiBaseUrl);
  if (options.clientToken !== undefined) {
    writeWindowGlobal('__NOTNATIVE_CLIENT_TOKEN__', options.clientToken);
  }
  if (options.requestHeaders) {
    writeWindowGlobal('__NOTNATIVE_RUNTIME_HEADERS__', options.requestHeaders);
  }

  // 2. resolver + credentials (generation bump invalidates in-flight token mints)
  configureRuntimeUrlResolver({ apiBaseUrl, realtimeBaseUrl: apiBaseUrl });
  if (options.requestHeaders) setRuntimeExtraHeaders(options.requestHeaders);
  if (options.clientToken !== undefined) setRuntimeBearerToken(options.clientToken);

  // 3. (relay activation would go here, BEFORE the mint — P11)

  // 4. fire-and-forget the token refresh; it rides the new credential set
  void refreshRuntimeUrlAuthToken(apiBaseUrl);

  dispatch('notnative:runtime-endpoint-changed', detail);
}

function dispatch(name: string, detail: RuntimeEndpointChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Same-instance transport change (LAN↔relay): no store teardown, no remount. */
export function reconnectAppForTransportSwitch(): void {
  // Grows in P1/P11: dispose terminal transports, rebind SDK client, reset
  // streaming state — session/view preserved (doc 01 §11.1).
}
