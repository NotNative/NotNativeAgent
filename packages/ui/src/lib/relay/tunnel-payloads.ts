// SPDX-License-Identifier: Apache-2.0
/**
 * Relay request/link builders for the client tunnel surface (doc 08
 * §3.10 `tunnel-payloads.ts` + §3.3 client-connection URL): URL
 * normalization to path+query (the virtual origin makes absolute URLs
 * ride the tunnel too), HttpRequest/StreamAbort/WsOpen/WsClose payload
 * builders, and the broker client-leg WS URL (role=client; grant rides
 * the URL for that one connection only and is never persisted).
 */
import { utf8Bytes } from './bytes.ts';
import { encodeJsonPayload, type HttpRequestPayload, type WsClosePayload } from './tunnel-codec.ts';

export const TUNNEL_PARSE_BASE = 'http://tunnel.invalid';

export interface NormalizedPathRequest {
  method: string;
  path: string; // path + query, never empty
  headers: Record<string, string>;
}

/** Absolute or path URLs both normalize to path?query on the throwaway
 * base; anything that cannot parse (empty/asterisk) throws. */
export function tunnelPathOf(url: string): string {
  const parsed = new URL(url, TUNNEL_PARSE_BASE);
  return `${parsed.pathname}${parsed.search}`;
}

/** ws/wss/http(s) URL → the WsOpen `path?query` (§3.10 `wsUrlToTunnelPath`). */
export function wsUrlToTunnelPath(url: string): string {
  const parsed = new URL(url, TUNNEL_PARSE_BASE);
  return `${parsed.pathname}${parsed.search}`;
}

export function encodeHttpRequestPayload(payload: HttpRequestPayload): Uint8Array {
  return encodeJsonPayload(payload);
}

export function encodeStreamAbortPayload(reason: string): Uint8Array {
  return encodeJsonPayload({ reason });
}

export function encodeWsOpenPayload(payload: { path: string; query?: Record<string, string>; protocols?: string[] }): Uint8Array {
  return encodeJsonPayload(payload);
}

/** Host-side close codes clamp to 1000..4999; the client passes through
 * and the host clamps (§3.9). */
export function encodeWsClosePayload(payload: WsClosePayload): Uint8Array {
  return encodeJsonPayload(payload);
}

export const RELAY_WS_PATH_DEFAULT = '/ws';

export interface ClientSocketUrlOptions {
  serverId: string;
  grant?: string;
  appId?: string;
  appVersion?: string;
  platform?: string;
  /** Extra query params (test/worker evolution hooks). */
  extra?: Record<string, string>;
}

/** The broker client-leg URL (§3.3): `?v=1&role=client&serverId=…`
 * `&appId=…&appVersion=…&platform=…[&grant=…]`. The appId/appVersion
 * keep the worker-contract strings byte-identical (E-08-25); a relay
 * base without a path gets the default `/ws`. */
export function buildClientRelaySocketUrl(relayUrl: string, options: ClientSocketUrlOptions): string {
  const base = new URL(relayUrl);
  if (base.pathname === '' || base.pathname === '/') base.pathname = RELAY_WS_PATH_DEFAULT;
  base.search = '';
  base.searchParams.set('v', '1');
  base.searchParams.set('role', 'client');
  base.searchParams.set('serverId', options.serverId);
  base.searchParams.set('appId', options.appId ?? 'openchamber');
  if (options.appVersion !== undefined) base.searchParams.set('appVersion', options.appVersion);
  if (options.platform !== undefined) base.searchParams.set('platform', options.platform);
  if (options.grant !== undefined && options.grant !== '') base.searchParams.set('grant', options.grant);
  for (const [key, value] of Object.entries(options.extra ?? {})) base.searchParams.set(key, value);
  return base.toString();
}

/** Single-serialized request body as bytes (one chunk). */
export function bodyToBytes(body: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof body === 'string') return utf8Bytes(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
}
