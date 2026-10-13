// SPDX-License-Identifier: Apache-2.0
/**
 * Panel decision logic for direct dev tunnels (doc 13 §H.4). Failure always
 * throws: silently opening the local URL would show the wrong machine under
 * the identity the user asked for.
 */
import { getApiBaseUrlActive, onRuntimeEndpointChanged } from '../runtime-switch.ts';
import { isDesktopShell } from '../platform.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::1']);
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/u;

export class DevTunnelUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DevTunnelUnavailableError';
  }
}

export interface DesktopTunnelBridge {
  open(input: { baseUrl: string; port: number }): Promise<{
    localPort: number; reused: boolean; url: string;
  }>;
  close(input: { baseUrl: string; port: number }): { closed: boolean };
}

export interface DevTunnelContext {
  isDesktop?: boolean;
  runtimeBaseUrl?: string | null;
  localOrigin?: string | null;
  openDesktopTunnel?: DesktopTunnelBridge | null;
}

interface CacheEntry {
  baseUrl: string;
  port: number;
  localPort: number;
  displayOrigin: string;
}

let desktopTunnel: DesktopTunnelBridge | null = null;
const cacheByKey = new Map<string, CacheEntry>();
const originByLocalPort = new Map<number, string>();
let cacheGeneration = 0;

/** In production the Electron seam injects the native web-package client. */
export function setDesktopTunnelBridge(bridge: DesktopTunnelBridge | null): void {
  desktopTunnel = bridge;
}

export function resetDevTunnelCache(): void {
  const entries = [...cacheByKey.values()];
  cacheGeneration += 1;
  cacheByKey.clear();
  originByLocalPort.clear();
  for (const entry of entries.slice().reverse()) {
    try { desktopTunnel?.close({ baseUrl: entry.baseUrl, port: entry.port }); } catch { /* endpoint switches close best effort */ }
  }
}

/** Consumer installs once on the Browser panel; synchronous resets are safe. */
export function installDevTunnelRuntimeInvalidation(): () => void {
  const close = onRuntimeEndpointChanged(() => resetDevTunnelCache());
  return close;
}

/** RFC-3986 loopback aliases canonicalized by WHATWG, plus explicit ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/u, '');
  return LOOPBACK_HOSTS.has(value) || IPV4_LOOPBACK.test(value)
    || (value.startsWith('[') && value.endsWith(']') && value.slice(1, -1) === '::1');
}

function effectivePort(url: URL): number | null {
  if (url.port !== '') return Number(url.port);
  if (url.protocol === 'http:' || url.protocol === 'ws:') return 80;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 443;
  return null;
}

function tunnelBase(context?: DevTunnelContext): URL | null {
  const value = context?.runtimeBaseUrl ?? getApiBaseUrlActive();
  if (!value) return null;
  try { return new URL(value); } catch { return null; }
}

function runtimeIsLocal(context?: DevTunnelContext): boolean {
  const runtime = tunnelBase(context);
  if (!runtime) return false;
  if (isLoopbackHost(runtime.hostname)) return true;
  const localOrigin = context?.localOrigin ?? window.__NOTNATIVE_LOCAL_ORIGIN__;
  try { return localOrigin ? runtime.origin === new URL(localOrigin).origin : false; } catch { return false; }
}

function bridgeFor(context?: DevTunnelContext): DesktopTunnelBridge {
  const bridge = context?.openDesktopTunnel !== undefined ? context.openDesktopTunnel : desktopTunnel;
  if (!bridge) throw new DevTunnelUnavailableError('Desktop dev-tunnel bridge is unavailable.');
  return bridge;
}

function forwardTarget(value: string, entry: CacheEntry): string {
  const original = new URL(value);
  original.protocol = new URL(entry.displayOrigin).protocol;
  original.host = `127.0.0.1:${entry.localPort}`;
  return original.href;
}

function mappedTarget(value: string, displayOrigin: string): string {
  const display = new URL(displayOrigin);
  const original = new URL(value);
  original.protocol = display.protocol;
  original.host = display.host;
  original.port = '';
  return original.href;
}

/**
 * Resolve a requested loopback URL to its real host-panel transport. A missing
 * bridge, discovery, auth, or listener error is surfaced as an explicit
 * DevTunnelUnavailableError; there is deliberately no plain-URL fallback.
 */
export async function resolveBrowsableUrl(value: string, context: DevTunnelContext = {}): Promise<string> {
  const url = new URL(value);
  if ((context.isDesktop ?? isDesktopShell()) === false || !isLoopbackHost(url.hostname)) return value;
  const runtime = tunnelBase(context);
  if (!runtime || runtimeIsLocal(context)) return value;
  const port = effectivePort(url);
  if (port === null || originByLocalPort.has(port)) return value;
  const cacheKey = `${runtime.href}|${port}`;
  const cached = cacheByKey.get(cacheKey);
  if (cached) return forwardTarget(value, cached);
  const bridge = bridgeFor(context);
  const generation = cacheGeneration;
  try {
    const opened = await bridge.open({ baseUrl: runtime.href, port });
    if (generation !== cacheGeneration) {
      try { bridge.close({ baseUrl: runtime.href, port }); } catch { /* already disposed */ }
      throw new DevTunnelUnavailableError('Runtime endpoint changed before the tunnel was ready.');
    }
    const displayOrigin = url.origin;
    const entry: CacheEntry = { baseUrl: runtime.href, port, localPort: opened.localPort, displayOrigin };
    cacheByKey.set(cacheKey, entry);
    originByLocalPort.set(opened.localPort, displayOrigin);
    return forwardTarget(value, entry);
  } catch (error) {
    throw new DevTunnelUnavailableError('Dev-server tunnel is unavailable.', { cause: error });
  }
}

/**
 * Same guards as resolve, without opening a tunnel. The tunnel-port skip is
 * for top-level retargeting to another host-local service, never this panel's
 * ephemeral transport port.
 */
export function shouldTunnelLoopbackUrl(value: string, context: DevTunnelContext = {}): boolean {
  try {
    const url = new URL(value);
    if ((context.isDesktop ?? isDesktopShell()) === false || !isLoopbackHost(url.hostname)) return false;
    const runtime = tunnelBase(context);
    if (!runtime || runtimeIsLocal(context)) return false;
    const port = effectivePort(url);
    return port !== null && !originByLocalPort.has(port);
  } catch { return false; }
}

/** Restore the real requested identity before display or persistence. */
export function toDisplayUrl(value: string, _context: DevTunnelContext = {}): string {
  const url = new URL(value);
  const port = effectivePort(url);
  const displayOrigin = port === null ? undefined : originByLocalPort.get(port);
  if (!displayOrigin) return value;
  return mappedTarget(value, displayOrigin);
}

export function devTunnelMetrics(): { cache: number; mappedPorts: number } {
  return { cache: cacheByKey.size, mappedPorts: originByLocalPort.size };
}

