// SPDX-License-Identifier: Apache-2.0
/**
 * Client outbound frame batching (doc 08 §3.7, negotiated `batch`): one
 * encrypted WS message may carry several tunnel frames — `1 → [0x00]
 * [frame bytes]`, `N → [0x01]([4B BE len][frame])*N`. Only stream payloads
 * (HttpBody/WsText/WsBinary) buffer; setup/teardown/keepalive frames
 * flush pending work first so per-stream order survives. The leading edge
 * ships immediately when the window is quiet (time-to-first-token stays
 * instant); teardown drops un-flushed frames. Caps: 24 KiB bytes /
 * 32 frames / the encrypted plaintext budget.
 */
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import {
  BATCH_BUFFERED_TYPES, encodeBatchContainer, encodeTunnelFrame, type TunnelFrame,
} from './tunnel-codec.ts';

export const DEFAULT_CLIENT_BATCH_WINDOW_MS = 150;
export const DEFAULT_CLIENT_BATCH_MAX_BYTES = 24 * 1024;
export const DEFAULT_CLIENT_BATCH_MAX_FRAMES = 32;
export const BATCH_ENVELOPE_RESERVED_BYTES = 1 + 4;

export interface ClientOutboundBatcher {
  offer(frame: TunnelFrame): void;
  /** Drops un-flushed work (teardown drops, §3.7) and keeps the batcher */
  reset(): void;
  dispose(): void;
  pendingBytes(): number;
}

export interface ClientOutboundBatcherDeps {
  isBatched: () => boolean;
  sendPlaintext: (bytes: Uint8Array) => void;
  windowMs?: number;
  maxBatchBytes?: number;
  maxBatchFrames?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
}

export function createClientOutboundBatcher(deps: ClientOutboundBatcherDeps): ClientOutboundBatcher {
  return new ClientOutboundBatcherImpl(deps);
}

interface BufferedEntry {
  bytes: Uint8Array;
  booked: number;
}

class ClientOutboundBatcherImpl implements ClientOutboundBatcher {
  private readonly deps: ClientOutboundBatcherDeps;
  private readonly windowMs: number;
  private readonly maxBatchBytes: number;
  private readonly maxBatchFrames: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly readClock: () => number;
  private buffered: BufferedEntry[] = [];
  private bufferedBytes = 0;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushStamp: number;
  private disposed = false;

  constructor(deps: ClientOutboundBatcherDeps) {
    this.deps = deps;
    this.windowMs = deps.windowMs ?? DEFAULT_CLIENT_BATCH_WINDOW_MS;
    this.maxBatchBytes = deps.maxBatchBytes ?? DEFAULT_CLIENT_BATCH_MAX_BYTES;
    this.maxBatchFrames = deps.maxBatchFrames ?? DEFAULT_CLIENT_BATCH_MAX_FRAMES;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.readClock = deps.now ?? Date.now;
    this.lastFlushStamp = this.readClock();
  }

  offer(frame: TunnelFrame): void {
    if (this.disposed) return;
    if (!this.deps.isBatched() || !BATCH_BUFFERED_TYPES.has(frame.type as number)) {
      this.flashAndShip(encodeTunnelFrame(frame));
      return;
    }
    const bytes = encodeTunnelFrame(frame);
    const booked = bytes.length + BATCH_ENVELOPE_RESERVED_BYTES;
    this.buffered.push({ bytes, booked });
    this.bufferedBytes += booked;
    if (this.capsReached()) {
      void this.flushNow();
      return;
    }
    if (this.readClock() - this.lastFlushStamp >= this.windowMs) {
      void this.flushNow(); // leading edge ships instantly (time-to-first-token)
      return;
    }
    this.scheduleWindow();
  }

  reset(): void {
    this.cancelWindow();
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelWindow();
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  pendingBytes(): number { return this.bufferedBytes; }

  private capsReached(): boolean {
    return this.buffered.length >= this.maxBatchFrames
      || this.bufferedBytes >= this.maxBatchBytes
      || this.bufferedBytes + BATCH_ENVELOPE_RESERVED_BYTES >= MAX_TUNNEL_PAYLOAD_BYTES;
  }

  /** Setup/teardown/keepalive frames keep per-stream order: flush first. */
  private flashAndShip(bytes: Uint8Array): void {
    this.flushNow();
    this.deps.sendPlaintext(bytes);
  }

  private flushNow(): void {
    this.cancelWindow();
    if (this.buffered.length === 0) return;
    const take = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.lastFlushStamp = this.readClock();
    this.deps.sendPlaintext(encodeBatchContainer(take.map((entry) => entry.bytes)));
  }

  private scheduleWindow(): void {
    if (this.windowTimer !== null) return;
    this.windowTimer = this.setTimeoutFn((): void => {
      this.windowTimer = null;
      void this.flushNow();
    }, Math.max(1, this.windowMs));
  }

  private cancelWindow(): void {
    if (this.windowTimer === null) return;
    this.clearTimeoutFn(this.windowTimer);
    this.windowTimer = null;
  }
}

