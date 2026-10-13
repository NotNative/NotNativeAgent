// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal WS protocol codec (doc 07 section 3): binary frames tagged 0x01
 * carrying JSON with protocol version v: 3 on every frame; 64 KiB payload
 * cap both directions; text frames / other tags / wrong version are
 * BAD_FRAME (non-fatal). Exact error-code taxonomy per section 3.2/3.3.
 */
import type { TerminalMode, TerminalPurpose, TerminalStatus } from './types.ts';

export const TERMINAL_WS_PATH = '/api/terminal/ws';
export const TERMINAL_WS_PROTOCOL_VERSION = 3;
export const TERMINAL_WS_TAG_JSON = 0x01;
export const TERMINAL_WS_MAX_PAYLOAD_BYTES = 65_536;
export const MAX_INPUT_CHARS = 65_536;

export type ServerToClientFrame =
  | { v: 3; t: 'hello' }
  | { v: 3; t: 'snapshot'; s: string; q: number; history: string; cols: number; rows: number; status: TerminalStatus; exitCode?: number; signal?: number; mode?: TerminalMode; purpose?: TerminalPurpose; runtime: 'node'; ptyBackend: string }
  | { v: 3; t: 'output'; s: string; q: number; d: string; r?: string }
  | { v: 3; t: 'exit'; s: string; q: number; exitCode?: number; signal?: number }
  | { v: 3; t: 'restarted'; s: string; q: number; history: '' }
  | { v: 3; t: 'error'; s?: string; code?: string; message?: string; fatal?: boolean }
  | { v: 3; t: 'pong' };

export type ClientToServerFrame =
  | { v: 3; t: 'hello' }
  | { v: 3; t: 'ping' }
  | { v: 3; t: 'attach'; s: string }
  | { v: 3; t: 'detach'; s: string }
  | { v: 3; t: 'write'; s: string; d: string };

export function encodeFrame(frame: ServerToClientFrame | ClientToServerFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  return Buffer.concat([Buffer.from([TERMINAL_WS_TAG_JSON]), body]);
}

export interface DecodedFrame { ok: true; frame: ClientToServerFrame } // typed client-side subset
export interface DecodeFailure { ok: false; code: 'BAD_FRAME' }

/** section 4.1: session ids are <= 128 chars; an absent/empty id is "no
 * session id" (BAD_FRAME, section 3.3). */
export const TERMINAL_MAX_ID_CHARS = 128;

export function isFrameSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= TERMINAL_MAX_ID_CHARS;
}

/** The server receives BOTH directions' frame grammar; unknown/invalid ->
 * BAD_FRAME (non-fatal). */
export function decodeFrame(data: unknown): DecodedFrame | DecodeFailure {
  if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
    return { ok: false, code: 'BAD_FRAME' };
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
  if (bytes.length === 0 || bytes[0] !== TERMINAL_WS_TAG_JSON) return { ok: false, code: 'BAD_FRAME' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(1).toString('utf8'));
  } catch {
    return { ok: false, code: 'BAD_FRAME' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, code: 'BAD_FRAME' };
  const frame = parsed as { v?: unknown; t?: unknown; s?: unknown; d?: unknown };
  if (frame.v !== TERMINAL_WS_PROTOCOL_VERSION) return { ok: false, code: 'BAD_FRAME' };
  if (frame.t === 'hello' || frame.t === 'ping') return { ok: true, frame: { v: 3, t: frame.t } };
  if (frame.t === 'attach' || frame.t === 'detach') {
    if (!isFrameSessionId(frame.s)) return { ok: false, code: 'BAD_FRAME' };
    return { ok: true, frame: { v: 3, t: frame.t, s: frame.s } };
  }
  if (frame.t === 'write') {
    if (!isFrameSessionId(frame.s) || typeof frame.d !== 'string') return { ok: false, code: 'BAD_FRAME' };
    if (frame.d.length < 1 || frame.d.length > MAX_INPUT_CHARS) return { ok: false, code: 'BAD_FRAME' };
    return { ok: true, frame: { v: 3, t: 'write', s: frame.s, d: frame.d } };
  }
  return { ok: false, code: 'BAD_FRAME' };
}
