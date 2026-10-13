// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal client protocol + transport (doc 07 sections 3/3.6/6.1): binary
 * frames 0x01+JSON v3 both directions, ONE socket per runtime, per-session
 * projections (512 KiB, UTF-8-safe head trim) for instant re-subscribe,
 * q-dedupe, reconnect matrix (500*2^(n-1) cap 8 s; 60 s slow path when
 * hidden/offline with instant wake; 10 s connect timeout; 45 s app ping;
 * 15 s idle socket hold), synthetic reconnecting events to subscribers.
 * The URL token/relay gate slot is registered (E-07-3).
 */
export const TERMINAL_WS_PATH = '/api/terminal/ws';
export const CLIENT_APP_PING_MS = 45_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 8_000;
export const SLOW_PATH_MS = 60_000;
export const IDLE_SOCKET_HOLD_MS = 15_000;
export const MAX_PROJECTION_BYTES = 512 * 1024;
export const MAX_INPUT_CHARS = 65_536;

export const MAX_COLS = 1000;
export const MAX_ROWS = 500;

export type TerminalStatus = 'running' | 'exited' | 'error' | 'reconnecting';

export interface TerminalPurposeWire {
  type: 'terminal' | 'project-action';
  actionId?: string;
  executionId?: string | null;
}

export interface TerminalSnapshotFrame {
  v: 3;
  t: 'snapshot';
  s: string;
  q: number;
  history: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode?: number;
  signal?: number;
  mode?: 'interactive' | 'command';
  purpose?: TerminalPurposeWire;
  runtime?: string;
  ptyBackend?: string;
}

export type TerminalEventFrame =
  { v: 3; t: 'hello' | 'pong' }
  | { v: 3; t: 'snapshot'; s: string; q: number; history: string; cols: number; rows: number; status: TerminalStatus; exitCode?: number; signal?: number; mode?: 'interactive' | 'command'; purpose?: TerminalPurposeWire }
  | { v: 3; t: 'output'; s: string; q: number; d: string; r?: string }
  | { v: 3; t: 'exit'; s: string; q: number; exitCode?: number; signal?: number }
  | { v: 3; t: 'restarted'; s: string; q: number; history: '' }
  | { v: 3; t: 'error'; s?: string; code?: string; message?: string; fatal?: boolean }
  | { v: 3; t: 'reconnecting'; s: string; attempt: number };

/** Sequence-bearing events (the q-dedupe plane). */
export type TerminalStreamEvent = { v: 3; t: 'output' | 'exit' | 'restarted'; s: string; q: number; d?: string; r?: string; exitCode?: number; signal?: number };

export interface TerminalProjection {
  sessionId: string;
  q: number;
  history: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode?: number;
  signal?: number;
  mode?: 'interactive' | 'command';
  purpose?: TerminalPurposeWire;
}

/** TerminalTransport: ships with a WebSocket factory so tests can inject. */
export interface WireSocket {
  send(data: Uint8Array | string): void;
  close(): void;
  onopen: ((this: WireSocket) => void) | null;
  onclose: ((this: WireSocket, event: { code?: number }) => void) | null;
  onerror: ((this: WireSocket, event: unknown) => void) | null;
  onmessage: ((this: WireSocket, event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WireSocket;

export function encodeTerminalFrame(frame: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(frame));
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = 0x01;
  bytes.set(body, 1);
  return bytes;
}

/** Blob payloads (browser WS default for binary) decode async; arrays and
 * ArrayBuffers decode both here. Realm-safe: the typing is structural
 * (Object.prototype.toString), because instanceof fails for node:buffer
 * pools under jsdom/web workers. Text frames decode to null. */
export async function decodeTerminalFrameAsync(data: unknown): Promise<TerminalEventFrame | null> {
  const tag = Object.prototype.toString.call(data);
  let bytes: Uint8Array | null = null;
  if (tag === '[object Blob]' && typeof (data as Blob).text === 'function') {
    bytes = new TextEncoder().encode(await (data as Blob).text());
  } else {
    bytes = wrapperBytes(tag, data);
  }
  if (bytes === null || bytes.length === 0 || bytes[0] !== 0x01) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as TerminalEventFrame;
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 3) return null;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function wrapperBytes(tag: string, data: unknown): Uint8Array | null {
  if (tag === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) {
    const view = data as Uint8Array;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  return null;
}

/** 512 KiB head trim (oldest dropped, doc invariant 6): whole leading
 * characters are dropped until the encoded fit holds. */
export function trimHead(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let index = bytes.length - maxBytes;
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index += 1; // land on a char boundary
  return new TextDecoder().decode(bytes.slice(index));
}
