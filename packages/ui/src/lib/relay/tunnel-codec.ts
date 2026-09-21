// SPDX-License-Identifier: Apache-2.0
/**
 * Relay Layer 3 — tunnel multiplexing codec (doc 08 §3.6), client mirror:
 * `[1B frameType|0x80 hasMoreFragments][4B BE streamId][payload]`, byte-
 * identical to the host mirror. Only WS message frames (WsText/WsBinary)
 * fragment; the assembler reassembles per (streamId, type) bounded at
 * 16 MiB with the distinct-partial-group cap. Batch containers (§3.7)
 * demux with mixed-mode tolerance ([0x00] single / [0x01] envelope) — the
 * strict container probe falls back to a bare frame when the leading 0x01
 * is an HttpRequest header byte instead of an envelope tag.
 */
import {
  TUNNEL_FRAME_HEADER_BYTES, HAS_MORE_FLAG, TunnelFrameType, MAX_ASSEMBLED_MESSAGE_BYTES,
  MAX_PENDING_FRAGMENT_STREAMS, isFragmentableType, type TunnelFrame,
} from './protocol.ts';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import { u8Concat, u8ReadUInt32BE, u8WriteUInt32BE, utf8Text, utf8Bytes } from './bytes.ts';

export { TunnelFrameType, TUNNEL_FRAME_HEADER_BYTES };
export type { TunnelFrame };

export class CodecError extends Error {}

/** §3.6: the numerals are the contract (never renumbered). */
const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(TunnelFrameType) as number[]);

export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  const head = (frame.type & 0x7f) | (frame.hasMore ? HAS_MORE_FLAG : 0);
  const bytes = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + frame.payload.length);
  bytes[0] = head & 0xff;
  u8WriteUInt32BE(bytes, frame.streamId >>> 0, 1);
  bytes.set(frame.payload, TUNNEL_FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame {
  if (bytes.length < TUNNEL_FRAME_HEADER_BYTES) throw new CodecError('tunnel frame header truncated');
  const type = (bytes[0] as number) & 0x7f;
  // §3.6: the frame numerals are the wire contract — a foreign numeral is a
  // protocol violation, never ignorable noise (§12.5 fail-closed parity
  // with the server mirror).
  if (!KNOWN_FRAME_TYPES.has(type)) throw new CodecError(`unknown tunnel frame type ${type}`);
  return {
    type,
    streamId: u8ReadUInt32BE(bytes, 1),
    hasMore: ((bytes[0] as number) & HAS_MORE_FLAG) !== 0,
    payload: bytes.subarray(TUNNEL_FRAME_HEADER_BYTES),
  };
}

/** Client-initiated streams use odd ids starting at 1 (increments by 2). */
export function createStreamIdAllocator(): { next(): number; peek(): number } {
  let current = 1;
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

/** Chunk sizes never exceed the encrypted plaintext budget (§3.5: a max
 * frame must fit one 64 KiB plaintext, header + envelope reserved). */
export function chunkPayload(payload: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new CodecError('chunk size must be a positive safe integer');
  if (chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) throw new CodecError(`chunk size exceeds the tunnel payload budget (${MAX_TUNNEL_PAYLOAD_BYTES})`);
  if (payload.length === 0) return [new Uint8Array(0)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

/** Fragment a WS message across frames (all but the last hasMore). */
export function encodeFragmentedMessage(
  type: TunnelFrameType,
  streamId: number,
  payload: Uint8Array,
  chunkSize: number,
): Uint8Array[] {
  if (!isFragmentableType(type)) throw new CodecError('only WS message frames may be fragmented');
  const chunks = chunkPayload(payload, chunkSize);
  return chunks.map((chunk, index) => encodeTunnelFrame({
    type,
    streamId,
    hasMore: index < chunks.length - 1,
    payload: chunk,
  }));
}

export type AssembledMessage = { type: TunnelFrameType; streamId: number; payload: Uint8Array };

/** Outbound batch container (§3.7, host-parity byte format): one frame →
 * `[0x00][frame bytes]`; N frames → `[0x01]([4B BE len][frame])*N`. */
export function encodeBatchContainer(frames: Uint8Array[]): Uint8Array {
  if (frames.length === 1) {
    return u8Concat([new Uint8Array([0x00]), frames[0] as Uint8Array]);
  }
  const parts: Uint8Array[] = [new Uint8Array([0x01])];
  for (const frame of frames) {
    const head = new Uint8Array(4);
    u8WriteUInt32BE(head, frame.length, 0);
    parts.push(head, frame);
  }
  return u8Concat(parts);
}

/** Reassembles per (streamId, frameType); non-fragmentable types arriving
 * fragmented are a hard channel error; 16 MiB cap counts the final chunk
 * too; distinct partial groups bounded. */
export function createFragmentAssembler(): {
  push(frame: TunnelFrame): AssembledMessage | null;
  reset(streamId?: number): void;
} {
  const parts = new Map<string, { type: number; streamId: number; chunks: Uint8Array[]; bytes: number }>();
  const keyFor = (frame: TunnelFrame): string => `${frame.streamId}:${frame.type}`;
  const complete = (frame: TunnelFrame): AssembledMessage => {
    const pending = parts.get(keyFor(frame));
    parts.delete(keyFor(frame));
    let payload: Uint8Array;
    if (pending === undefined) {
      payload = frame.payload;
    } else {
      payload = u8Concat([...pending.chunks, frame.payload]);
    }
    if (payload.length > MAX_ASSEMBLED_MESSAGE_BYTES) {
      throw new CodecError(`assembled message exceeds ${MAX_ASSEMBLED_MESSAGE_BYTES} bytes`);
    }
    return { type: frame.type as TunnelFrameType, streamId: frame.streamId, payload };
  };
  return {
    push(frame: TunnelFrame): AssembledMessage | null {
      if (frame.hasMore && !isFragmentableType(frame.type as number)) {
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

// ---- batch container demux (§3.7, host-parity byte format) ----------------

export const BATCH_BUFFERED_TYPES: ReadonlySet<number> = new Set([
  TunnelFrameType.HttpBody,
  TunnelFrameType.WsText,
  TunnelFrameType.WsBinary,
]);

export type ContainerDecode =
  | { kind: 'single'; frame: TunnelFrame }
  | { kind: 'batch'; frames: TunnelFrame[] }
  | null;

/** [0x00] singles pass through; [0x01] ships a CONTAINER only when it
 * parses as an exact length-prefixed run of legal buffered-type frames.
 * Anything else is a BARE frame's header byte (type 1 HttpRequest ships
 * envelope-free) → the caller fails the channel on null. */
export function decodeFrameOrContainer(bytes: Uint8Array): { kind: 'single'; frames: [TunnelFrame] } | { kind: 'batch'; frames: TunnelFrame[] } | null {
  if (bytes.length < 1) return null;
  const tag = bytes[0] as number;
  if (tag === 0x00) return decodeBatchContainerBytes(bytes);
  if (tag === 0x01 && isStrictBatchContainer(bytes)) return decodeBatchContainerBytes(bytes as Uint8Array);
  if (bytes.length < TUNNEL_FRAME_HEADER_BYTES) return null;
  return { kind: 'single', frames: [decodeTunnelFrame(bytes)] };
}

/** Container parse with mixed-mode tolerance; null = not a container. */
function decodeBatchContainerBytes(bytes: Uint8Array): { kind: 'single'; frames: [TunnelFrame] } | { kind: 'batch'; frames: TunnelFrame[] } | null {
  const tag = bytes[0] as number;
  if (tag === 0x00) {
    if (bytes.length < 1 + TUNNEL_FRAME_HEADER_BYTES) return null; // truncated single
    return { kind: 'single', frames: [decodeTunnelFrame(bytes.subarray(1))] };
  }
  const frames: TunnelFrame[] = [];
  let cursor = 1;
  while (cursor + 4 <= bytes.length) {
    const length = u8ReadUInt32BE(bytes, cursor);
    cursor += 4;
    if (length > bytes.length - cursor) return null;
    frames.push(decodeTunnelFrame(bytes.subarray(cursor, cursor + length)));
    cursor += length;
  }
  if (cursor !== bytes.length) return null;
  return { kind: 'batch', frames };
}

function isStrictBatchContainer(bytes: Uint8Array): boolean {
  let cursor = 1;
  let segments = 0;
  while (cursor + 4 <= bytes.length) {
    const length = u8ReadUInt32BE(bytes, cursor);
    cursor += 4;
    if (length < TUNNEL_FRAME_HEADER_BYTES || length > bytes.length - cursor) return false;
    if (!BATCH_BUFFERED_TYPES.has((bytes[cursor] as number) & 0x7f)) return false;
    cursor += length;
    segments += 1;
  }
  return cursor === bytes.length && segments >= 1;
}

// ---- JSON payload guards (§3.6/§3.9; wrong shapes fail closed) ------------

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

export function encodeJsonPayload(value: unknown): Uint8Array {
  return utf8Bytes(JSON.stringify(value));
}

export function parseJsonPayload<T>(payload: Uint8Array, guard: (value: unknown) => value is T): T | null {
  try {
    const parsed: unknown = JSON.parse(utf8Text(payload));
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

/** HTTP statuses are integers 100..599 (E-08-24); malformed heads fail at
 * parse instead of constructing a nonsense Response downstream. */
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
  if (value.protocols === undefined) return true;
  return Array.isArray(value.protocols) && (value.protocols as unknown[]).every((p) => typeof p === 'string');
}

export function isWsOpenedPayload(value: unknown): value is WsOpenedPayload {
  return isRecord(value) && (value.protocol === undefined || typeof value.protocol === 'string');
}

/** WS-grade integer close codes; hostile/NaN codes die at parse (E-08-24). */
export function isWsClosePayload(value: unknown): value is WsClosePayload {
  if (!isRecord(value)) return false;
  return typeof value.code === 'number' && Number.isSafeInteger(value.code)
    && (value.reason === undefined || typeof value.reason === 'string');
}
