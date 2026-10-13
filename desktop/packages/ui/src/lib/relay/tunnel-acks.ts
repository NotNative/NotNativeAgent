// SPDX-License-Identifier: Apache-2.0
/**
 * Client DeliveryAck ledger (doc 08 §3.8, `tunnel-client.ts` ack logic):
 * the client sends encrypted DeliveryAck frames on stream zero carrying
 * the 8-byte unsigned big-endian CUMULATIVE count of received raw
 * tunnel-frame bytes on nonzero streams (the 5-byte frame header
 * included; batch envelopes, encryption overhead, and stream-zero
 * keepalives excluded). The count resets with each handshake. ACKs cover
 * complete frames only and include late frames of cancelled streams
 * (they still consumed credit). Cadence: inline flush when the unacked
 * delta crosses 16 KiB on a received batch, plus a 10 ms tail timer so a
 * final small frame cannot strand sender credit. Ack/keepalive processing
 * never awaits downstream credit (that would deadlock the channel).
 */
import { u8WriteBigUInt64BE } from './bytes.ts';
import { STREAM_ZERO, TUNNEL_FRAME_HEADER_BYTES, type TunnelFrame } from './protocol.ts';

export const ACK_INLINE_THRESHOLD_BYTES = 16 * 1024;
export const ACK_TAIL_TIMER_MS = 10;

export interface AckLedger {
  /** Call for EVERY decoded (dispatched or dropped) nonzero-stream frame. */
  noteFrame(frame: TunnelFrame): void;
  /** Per received batch: inline flush over the threshold; arms the tail. */
  afterBatch(): void;
  reset(): void;
  dispose(): void;
  stats(): { receivedBytes: number; acknowledged: number; tailArmed: boolean };
}

export interface AckLedgerOptions {
  sendAck: (payload: Uint8Array) => void;
  ackInlineThresholdBytes?: number;
  tailTimerMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createAckLedger(options: AckLedgerOptions): AckLedger {
  const threshold = options.ackInlineThresholdBytes ?? ACK_INLINE_THRESHOLD_BYTES;
  const tailTimerMs = options.tailTimerMs ?? ACK_TAIL_TIMER_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let receivedBytes = 0;
  let acknowledged = 0;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function cancelTail(): void {
    if (tailTimer === null) return;
    clearTimeoutFn(tailTimer);
    tailTimer = null;
  }

  function flushInline(): void {
    cancelTail();
    if (acknowledged === receivedBytes) return;
    acknowledged = receivedBytes;
    const payload = new Uint8Array(8);
    u8WriteBigUInt64BE(payload, BigInt(acknowledged), 0);
    options.sendAck(payload);
  }

  return {
    noteFrame(frame: TunnelFrame): void {
      if (disposed) return;
      if (frame.streamId === STREAM_ZERO) return; // keepalives excluded from the ledger
      receivedBytes += TUNNEL_FRAME_HEADER_BYTES + frame.payload.length;
    },
    afterBatch(): void {
      if (disposed) return;
      const delta = receivedBytes - acknowledged;
      if (delta >= threshold) {
        flushInline();
        return;
      }
      if (delta > 0 && tailTimer === null) {
        tailTimer = setTimeoutFn(() => {
          tailTimer = null;
          flushInline();
        }, tailTimerMs);
      }
    },
    reset(): void {
      cancelTail();
      receivedBytes = 0;
      acknowledged = 0;
    },
    dispose(): void {
      disposed = true;
      cancelTail();
    },
    stats(): { receivedBytes: number; acknowledged: number; tailArmed: boolean } {
      return { receivedBytes, acknowledged, tailArmed: tailTimer !== null };
    },
  };
}
