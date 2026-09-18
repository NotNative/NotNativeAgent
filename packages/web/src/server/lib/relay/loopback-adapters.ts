// SPDX-License-Identifier: Apache-2.0
/**
 * Loopback forwarding adapters for the relay host dispatcher (doc 08
 * section 3.9): header normalization (hop-by-hop strip both directions;
 * CR/LF in a name or value drops the whole header), request init shaping
 * (web ReadableStream bodies ride `duplex:'half'` for undici; buffered
 * bodies stay plain Uint8Arrays so the transfer keeps content-length
 * framing), and the default global-fetch adapter whose ReadableStream
 * response bodies iterate async.
 */
import { type HttpRequestPayload } from './tunnel-codec.ts';
import type { RelayHostSocketLikeFactory } from './dispatcher-ws.ts';

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
]);

export interface LoopbackRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  duplex?: 'half';
}

export interface LoopbackResponseLike {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array> | null;
}

export function normalizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (name.includes('\r') || name.includes('\n') || value.includes('\r') || value.includes('\n')) continue;
    clean[name] = value;
  }
  return clean;
}

export function normalizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    clean[name] = value;
  }
  return clean;
}

export function requestInitOf(head: HttpRequestPayload, headers: Record<string, string>, body: unknown, signal: AbortSignal): LoopbackRequestInit {
  return {
    method: head.method.toUpperCase(),
    headers,
    ...(body !== undefined ? { body } : {}),
    signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
  };
}

export function defaultLoopbackFetch(): (url: string, init: LoopbackRequestInit) => Promise<LoopbackResponseLike> {  return async (url, init) => {
    const response = await fetch(url, init as never);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return {
      status: response.status,
      headers,
      body: response.body === null ? null : (response.body as unknown as AsyncIterableIterator<Uint8Array>),
    };
  };
}

export function unavailableSocketFactory(): RelayHostSocketLikeFactory {
  return (url, protocols, extraHeaders) => {
    void url; void protocols; void extraHeaders;
    throw new Error('the ws loopback adapter lands with the host service wiring');
  };
}
