// SPDX-License-Identifier: Apache-2.0
/**
 * Relay protocol constants (doc 08 §3.1, `protocol.ts`): the frame-type
 * numerals, stream id discipline, close-code policy, and capability defaults.
 * Types are a numeric contract, never renumbered (E-08-25 wire parity).
 */
import type { RelayJwk } from './protocol-jwk.ts';

export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const HAS_MORE_FLAG = 0x80;

export const MAX_ASSEMBLED_MESSAGE_BYTES = 16 * 1024 * 1024;
/** NND hardening: bound the distinct (streamId, type) partial groups held. */
export const MAX_PENDING_FRAGMENT_STREAMS = 256;

export const STREAM_ZERO = 0;
/** Client-initiated streams take odd ids starting at 1 (increments by 2). */
export const CLIENT_FIRST_STREAM_ID = 1;

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

export interface TunnelFrame {
  type: TunnelFrameType | number;
  streamId: number;
  hasMore: boolean;
  payload: Uint8Array;
}

/** Fragments (the 0x80 hasMore bit) are legal on WS message frames only. */
export function isFragmentableType(type: TunnelFrameType | number): boolean {
  return type === TunnelFrameType.WsText || type === TunnelFrameType.WsBinary;
}

/** Worker close codes a client leg may receive (§3.3) with client policy. */
export const CLIENT_CLOSE_REKEY = 1008; // rekey mismatch (fail closed)
export const CLIENT_CLOSE_CHANNEL = 1011; // E2EE/framing failure (fail closed)
export const CLIENT_CLOSE_HOST_GONE = 1012; // host went away; retry
export const WS_LOCAL_SOCKET_KILLED = 1006; // local surface for a host StreamAbort
export const WS_CHANNEL_DEATH = 1012; // WS surface for channel death ("host went away, retry")

/** Terminal client-side close codes: retained error, no reconnect, fail fast. */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([4010, 4002, 4029]);

export const CLOSE_CODE_4002_DUPLICATE = 4002;
export const CLOSE_CODE_4010_AUTH_FAILED = 4010;
export const CLOSE_CODE_4029_LIMIT = 4029;

/** Timing contract (§3.11, client side unless noted) — ms. */
export const HELLO_RETRY_MS = 1000;
export const HELLO_TIMEOUT_MS = 30_000;
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 15_000;
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;
export const HIDDEN_OR_OFFLINE_MAX_DELAY_MS = 60_000;

export type { RelayJwk };
