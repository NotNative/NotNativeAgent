// SPDX-License-Identifier: Apache-2.0
/**
 * Relay Layer 3 — tunnel multiplexing codec (doc 08 section 3.6,
 * byte-identical contract): `[1B frameType|0x80 hasMoreFragments][4B BE
 * streamId][payload]`. Types are a numeric contract, never renumbered.
 * Only WS message frames (WsText/WsBinary) may be fragmented; the
 * assembler reassembles per (streamId, frameType) bounded at 16 MiB.
 * Client streams take odd ids starting at 1; stream 0 is the control id
 * (Ping/Pong/DeliveryAck never wait on credit). Chunk sizes never exceed
 * MAX_TUNNEL_PAYLOAD_BYTES (doc 08 section 3.5: a max frame must fit one
 * 64 KiB encrypted plaintext, header + batch envelope reserved), and the
 * assembler caps partially received streams so a fragmented-frame flood
 * across many stream ids cannot grow memory unboundedly (256 slots).
 */
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';

export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const MAX_ASSEMBLED_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Doc bounds MESSAGE bytes only; NND hardening: distinct
 * (streamId, type) partials held at once. Exceeding it is a channel
 * error (fail closed), matching the overflow posture. */
export const MAX_PENDING_FRAGMENT_STREAMS = 256;

export const TunnelFrameType = {
  HttpRequest: 1,
  HttpBody: 2,
  HttpResponse: 3,
  StreamEnd: 4,
  StreamAbort: 5,
  WsOpen: 6,
  WsOpened: 7,
  WsText: 8,
  WsBinary: 9,
  WsClose: 10,
  Ping: 11,
  Pong: 12,
  DeliveryAck: 13,
} as const;
export type TunnelFrameType = (typeof TunnelFrameType)[keyof typeof TunnelFrameType];

export const HAS_MORE_FLAG = 0x80;

/** §3.6: the frame numerals are the wire contract (never renumbered) — a
 * foreign numeral is a protocol violation, not ignorable noise (§12.5:
 * fail-closed defaults; the demux's bare-frame fallback leans on THIS
 * decoder to refuse unrecognizable types). */
const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(TunnelFrameType) as number[]);

export interface TunnelFrame {
  type: TunnelFrameType | number;
  streamId: number;
  hasMore: boolean;
  payload: Buffer;
}

export function encodeTunnelFrame(frame: TunnelFrame): Buffer {
  const head = (frame.type & 0x7f) | (frame.hasMore ? HAS_MORE_FLAG : 0);
  const header = Buffer.alloc(TUNNEL_FRAME_HEADER_BYTES);
  header.writeUInt8(head, 0);
  header.writeUInt32BE(frame.streamId >>> 0, 1);
  return Buffer.concat([header, frame.payload]);
}

export function decodeTunnelFrame(bytes: Buffer): TunnelFrame {
  if (bytes.length < TUNNEL_FRAME_HEADER_BYTES) throw new CodecError('tunnel frame header truncated');
  const head = bytes.readUInt8(0);
  const type = head & 0x7f;
  if (!KNOWN_FRAME_TYPES.has(type)) throw new CodecError(`unknown tunnel frame type ${type}`);
  return {
    type,
    streamId: bytes.readUInt32BE(1),
    hasMore: (head & HAS_MORE_FLAG) !== 0,
    payload: bytes.subarray(TUNNEL_FRAME_HEADER_BYTES),
  };
}

export class CodecError extends Error {}

export function isFragmentableType(type: TunnelFrameType | number): boolean {
  return type === TunnelFrameType.WsText || type === TunnelFrameType.WsBinary;
}

/** Client-initiated streams use odd ids starting at 1 (increments by 2). */
export function createStreamIdAllocator(start = 1): { next(): number; peek(): number } {
  let current = start;
  if (current % 2 === 0) current += 1;
  return {
    next(): number {
      const id = current;
      current += 2;
      return id;
    },
    peek(): number {
      return current;
    },
  };
}

/** Docs: an empty chunked body yields one empty chunk, never zero frames. */
export function chunkPayload(payload: Buffer, chunkSize: number): Buffer[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new CodecError('chunk size must be a positive safe integer');
  if (chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) throw new CodecError(`chunk size exceeds the tunnel payload budget (${MAX_TUNNEL_PAYLOAD_BYTES})`);
  if (payload.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

/** Fragment a WS message across frames (all but the last hasMore). */
export function encodeFragmentedMessage(
  type: TunnelFrameType,
  streamId: number,
  payload: Buffer,
  chunkSize: number,
): Buffer[] {
  if (!isFragmentableType(type)) throw new CodecError('only WS message frames may be fragmented');
  const chunks = chunkPayload(payload, chunkSize);
  return chunks.map((chunk, index) => encodeTunnelFrame({
    type,
    streamId,
    hasMore: index < chunks.length - 1,
    payload: chunk,
  }));
}

export type AssembledMessage = { type: TunnelFrameType; streamId: number; payload: Buffer };

/** Reassembles per (streamId, frameType); non-fragmentable types arriving
 * fragmented are a hard channel error; overflow past 16 MiB fails (the
 * final chunk is counted too), and the distinct partial-group count is
 * bounded (fragmented-frame flood across many stream ids). */
export function createFragmentAssembler(): {
  push(frame: TunnelFrame): AssembledMessage | null;
  reset(streamId?: number): void;
} {
  const parts = new Map<string, { type: number; streamId: number; chunks: Buffer[]; bytes: number }>();
  const keyFor = (frame: TunnelFrame): string => `${frame.streamId}:${frame.type}`;
  const complete = (frame: TunnelFrame): AssembledMessage => {
    const key = keyFor(frame);
    const pending = parts.get(key);
    parts.delete(key);
    if (pending === undefined) {
      if (frame.payload.length > MAX_ASSEMBLED_MESSAGE_BYTES) {
        throw new CodecError(`assembled message exceeds ${MAX_ASSEMBLED_MESSAGE_BYTES} bytes`);
      }
      return { type: frame.type as TunnelFrameType, streamId: frame.streamId, payload: frame.payload };
    }
    if (pending.bytes + frame.payload.length > MAX_ASSEMBLED_MESSAGE_BYTES) {
      throw new CodecError(`assembled message exceeds ${MAX_ASSEMBLED_MESSAGE_BYTES} bytes`);
    }
    return { type: frame.type as TunnelFrameType, streamId: frame.streamId, payload: Buffer.concat([...pending.chunks, frame.payload]) };
  };
  return {
    push(frame: TunnelFrame): AssembledMessage | null {
      if (frame.hasMore && !isFragmentableType(frame.type)) {
        throw new CodecError(`non-fragmentable frame type ${frame.type} arrived fragmented`);
      }
      if (!frame.hasMore) return complete(frame);
      const key = keyFor(frame);
      if (parts.get(key) === undefined && parts.size >= MAX_PENDING_FRAGMENT_STREAMS) {
        throw new CodecError(`too many partial fragment groups (bound ${MAX_PENDING_FRAGMENT_STREAMS} streams)`);
      }
      const entry = parts.get(key) ?? { type: frame.type as number, streamId: frame.streamId, chunks: [], bytes: 0 };
      entry.chunks.push(frame.payload);
      entry.bytes += frame.payload.length;
      if (entry.bytes > MAX_ASSEMBLED_MESSAGE_BYTES) {
        parts.delete(key);
        throw new CodecError(`assembled message exceeds ${MAX_ASSEMBLED_MESSAGE_BYTES} bytes`);
      }
      parts.set(key, entry);
      return null;
    },
    reset(streamId?: number): void {
      if (streamId === undefined) {
        parts.clear();
        return;
      }
      for (const key of parts.keys()) {
        if (key.startsWith(`${streamId}:`)) parts.delete(key);
      }
    },
  };
}

// ---- payload shape guards (doc: JSON payloads are UTF-8; wrong shapes
// abort the stream / fail the channel) --------------------------------------

export interface HttpRequestPayload {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  hasBody?: boolean;
}

export interface HttpResponsePayload {
  status: number;
  headers: Record<string, string>;
}

export interface StreamAbortPayload { reason: string }
export interface WsOpenPayload { path: string; query?: Record<string, string>; protocols?: string[] }
export interface WsOpenedPayload { protocol?: string }
export interface WsClosePayload { code: number; reason?: string }

export function encodeJsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function parseJsonPayload<T>(payload: Buffer, guard: (value: unknown) => value is T): T | null {
  try {
    const parsed: unknown = JSON.parse(payload.toString('utf8'));
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

export function isHttpRequestPayload(value: unknown): value is HttpRequestPayload {
  if (!isRecord(value)) return false;
  return typeof value.method === 'string' && typeof value.path === 'string'
    && stringMap(value.query ?? {}) && stringMap(value.headers ?? {})
    && (value.hasBody === undefined || typeof value.hasBody === 'boolean');
}

/** E-08-24: HTTP statuses are integers in the 100..599 valid range; a
 * malformed host pipe fails at parse instead of constructing a nonsense
 * Response downstream. */
export function isHttpResponsePayload(value: unknown): value is HttpResponsePayload {
  if (!isRecord(value)) return false;
  const status = value.status;
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599
    && stringMap(value.headers ?? {});
}

export function isStreamAbortPayload(value: unknown): value is StreamAbortPayload {
  return isRecord(value) && typeof value.reason === 'string';
}

export function isWsOpenPayload(value: unknown): value is WsOpenPayload {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  if (!stringMap(value.query ?? {})) return false;
  if (value.protocols === undefined) return true; // optional subprotocol list
  return Array.isArray(value.protocols) && (value.protocols as unknown[]).every((p) => typeof p === 'string');
}

export function isWsOpenedPayload(value: unknown): value is WsOpenedPayload {
  return isRecord(value) && (value.protocol === undefined || typeof value.protocol === 'string');
}

/** E-08-24: close code must be a WS-grade integer (the dispatcher clamps
 * to 1000..4999; a hostile/NaN code dies here, never in a byte writer). */
export function isWsClosePayload(value: unknown): value is WsClosePayload {
  if (!isRecord(value)) return false;
  return typeof value.code === 'number' && Number.isSafeInteger(value.code)
    && (value.reason === undefined || typeof value.reason === 'string');
}
