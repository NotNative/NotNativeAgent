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
import type { RelayHostSocketLike, RelayHostSocketLikeFactory } from './dispatcher-ws.ts';
import { WebSocket as WsDialer, type RawData } from 'ws';

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

const LOOPBACK_WS_MAX_PAYLOAD = 16 * 1024 * 1024; // §3.10 sub-message cap mirror (dispatcher-ws comment)

function bufferOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * Production loopback WS dial (§3.9 ws mux): a `ws` client toward the
 * local HTTP server with the injected origin + relay-connection headers
 * and a 16 MiB maxPayload — the real adapter referenced by dispatcher-ws.
 */
export function createLoopbackSocketFactory(): RelayHostSocketLikeFactory {
  return (url, protocols, extraHeaders) => new RealLoopbackSocket(url, protocols, extraHeaders);
}

class RealLoopbackSocket implements RelayHostSocketLike {
  private readonly ws: WsDialer;
  private messageHandler: ((data: Buffer, isBinary: boolean) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private openHandler: (() => void) | null = null;

  constructor(url: string, protocols: string[], extraHeaders: Record<string, string>) {
    this.ws = new WsDialer(url, protocols.length > 0 ? protocols : [], {
      headers: extraHeaders,
      maxPayload: LOOPBACK_WS_MAX_PAYLOAD,
    });
    this.ws.on('open', () => this.openHandler?.());
    this.ws.on('message', (data: RawData, isBinary: boolean) => this.messageHandler?.(bufferOf(data), isBinary));
    this.ws.on('close', (code: number, reason: Buffer) => this.closeHandler?.(code, reason.toString('utf8')));
    this.ws.on('error', (error: Error) => this.errorHandler?.(error));
  }

  get protocol(): string {
    return this.ws.protocol ?? '';
  }

  send(data: Buffer, isBinary: boolean): void {
    if (this.ws.readyState === WsDialer.OPEN) {
      this.ws.send(data, { binary: isBinary });
      return;
    }
    if (this.ws.readyState === WsDialer.CONNECTING) {
      this.ws.once('open', () => this.send(data, isBinary)); // CONNECTING: ship on transit
    } // CLOSING/CLOSED: the close handler owns downstream teardown (nothing to send)
  }

  close(code: number, reason?: string): void {
    try {
      this.ws.close(code, reason ?? '');
    } catch {
      this.ws.terminate();
    }
  }

  terminate(): void {
    this.ws.terminate();
  }

  on(event: 'message', handler: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', handler: (code: number, reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'open', handler: () => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    switch (event) {
      case 'message': this.messageHandler = handler as (data: Buffer, isBinary: boolean) => void; return;
      case 'close': this.closeHandler = handler as (code: number, reason: string) => void; return;
      case 'error': this.errorHandler = handler as (error: Error) => void; return;
      default: this.openHandler = handler as () => void; return;
    }
  }
}
