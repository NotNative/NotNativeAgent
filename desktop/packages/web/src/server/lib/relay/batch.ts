// SPDX-License-Identifier: Apache-2.0
/**
 * Relay Layer 3.7 — outbound frame batching (optional `batch` capability):
 * one encrypted WS message may carry several tunnel frames. Container:
 * 1 frame -> [0x00][frame bytes]; N frames -> [0x01]([4B BE len][frame])*N.
 * Only stream payloads (HttpBody/WsText/WsBinary) buffer; setup/teardown/
 * keepalive frames flush pending work to preserve per-stream order. The
 * leading edge ships immediately when the window is quiet (time-to-first-
 * token stays instant); teardown drops un-flushed frames.
 */
import {
  MAX_PLAINTEXT_FRAME_BYTES,
} from './crypto.ts';
import {
  TUNNEL_FRAME_HEADER_BYTES,
  TunnelFrameType,
  encodeTunnelFrame, type TunnelFrame,
} from './tunnel-codec.ts';

export const BATCH_ENVELOPE_RESERVED_BYTES = 1 + 4; // worst-case headroom per buffered frame [envelope tag][4B len]
export const DEFAULT_BATCH_WINDOW_MS = 150;
export const DEFAULT_MAX_BATCH_BYTES = 24 * 1024;
export const DEFAULT_MAX_BATCH_FRAMES = 32;
export const BATCH_BUFFERED_TYPES: ReadonlySet<number> = new Set([
  TunnelFrameType.HttpBody,
  TunnelFrameType.WsText,
  TunnelFrameType.WsBinary,
]);

export function encodeBatchContainer(frames: Buffer[]): Buffer {
  if (frames.length === 1) {
    return Buffer.concat([Buffer.of(0x00), frames[0]!]);
  }
  const parts: Buffer[] = [Buffer.of(0x01)];
  for (const frame of frames) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(frame.length, 0);
    parts.push(head, frame);
  }
  return Buffer.concat(parts);
}

/** Decode with mixed-mode tolerance: [0x00] single, [0x01] envelope;
 * anything else is not a batch container (the caller handles the error). */
export function decodeBatchContainer(bytes: Buffer): { kind: 'single'; frame: Buffer } | { kind: 'batch'; frames: Buffer[] } | null {
  if (bytes.length < 1) return null;
  const tag = bytes.readUInt8(0);
  if (tag === 0x00) return { kind: 'single', frame: bytes.subarray(1) };
  if (tag !== 0x01) return null;
  const frames: Buffer[] = [];
  let cursor = 1;
  while (cursor + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    cursor += 4;
    if (length > bytes.length - cursor) return null; // truncated envelope
    frames.push(Buffer.from(bytes.subarray(cursor, cursor + length)));
    cursor += length;
  }
  if (cursor !== bytes.length) return null;
  return { kind: 'batch', frames };
}

/** Mixed-mode L2 demux (the §3.7 wire truth the batcher ships): [0x00]
 * singles pass through; a [0x01]-leading message is a batch CONTAINER only
 * when it parses as an exact length-prefixed run whose every frame is a
 * legal ≥ 5 B tunnel frame of a BUFFERED type (HttpBody/WsText/WsBinary —
 * the only frames the shared batcher ever puts in a container). Otherwise
 * the 0x01 first byte is a BARE frame's header byte: type 1 HttpRequest
 * (or type 0 flag-noise) ships envelope-free per §3.7 ("non-buffered
 * singles go bare"), so the strict container probe MUST fall back instead
 * of miscasting the open wire. A bare fallback under a 5 B header, and an
 * unclassifiable message, return null (the caller fails the channel).
 * Residual aliasing: a bare HttpRequest whose streamId exactly spans a
 * payload that starts with a buffered-type byte is a self-inflicted
 * client defect and the stream bounds contain it. */
export function decodeFrameOrContainer(bytes: Buffer): { kind: 'single'; frame: Buffer } | { kind: 'batch'; frames: Buffer[] } | null {
  if (bytes.length < 1) return null;
  const tag = bytes[0]!;
  if (tag === 0x00) return decodeBatchContainer(bytes);
  if (tag === 0x01 && isStrictBatchContainer(bytes)) return decodeBatchContainer(bytes);
  if (bytes.length < TUNNEL_FRAME_HEADER_BYTES) return null;
  return { kind: 'single', frame: bytes };
}

/** The 0x01 demux discriminator: an exact multi-segment parse (every
 * segment ≥ header bytes; N ≥ 1; no trailing slack) over BUFFERED-type
 * frames only — the shape every legal container producer emits. */
function isStrictBatchContainer(bytes: Buffer): boolean {
  let cursor = 1;
  let segments = 0;
  while (cursor + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    cursor += 4;
    if (length < TUNNEL_FRAME_HEADER_BYTES || length > bytes.length - cursor) return false;
    const frame = bytes.subarray(cursor, cursor + length);
    if (!BATCH_BUFFERED_TYPES.has(frame[0]! & 0x7f)) return false;
    cursor += length;
    segments += 1;
  }
  return cursor === bytes.length && segments >= 1;
}

export interface OutboundBatcherOptions {
  windowMs?: number;
  maxBatchBytes?: number;
  maxBatchFrames?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
}

/** One frame or a batch container goes out through `send`; the flush
 * never interleaves per-stream order (setup frames flush first). */
export interface OutboundFrameBatcher {
  offer(frame: TunnelFrame): Promise<void>;
  /** Same gate, fed pre-encoded frame bytes (encoded-frame carriers):
   * the type comes from the header byte; the stored bytes re-encode free. */
  offerEncoded(frameBytes: Buffer): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
  pendingBytes(): number;
}

export function createOutboundFrameBatcher(
  send: (frameBytes: Buffer) => void | Promise<void>,
  options: OutboundBatcherOptions = {},
): OutboundFrameBatcher {
  return new OutboundFrameBatcherImpl(send, options);
}

class OutboundFrameBatcherImpl implements OutboundFrameBatcher {
  private readonly send: (frameBytes: Buffer) => void | Promise<void>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly readClock: () => number;
  private readonly windowMs: number;
  private readonly maxBatchBytes: number;
  private readonly maxBatchFrames: number;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastFlushStamp: number;

  constructor(send: (frameBytes: Buffer) => void | Promise<void>, options: OutboundBatcherOptions) {
    this.send = send;
    this.windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxBatchFrames = options.maxBatchFrames ?? DEFAULT_MAX_BATCH_FRAMES;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.readClock = options.now ?? Date.now;
    this.lastFlushStamp = this.readClock();
  }

  offer(frame: TunnelFrame): Promise<void> {
    return this.enqueue(() => this.offerNowBytes(encodeTunnelFrame(frame)));
  }

  offerEncoded(frameBytes: Buffer): Promise<void> {
    return this.enqueue(() => this.offerNowBytes(frameBytes));
  }

  flush(): Promise<void> {
    return this.enqueue(() => this.flushBuffer());
  }

  dispose(): void {
    this.disposed = true;
    this.cancelWindow();
    this.buffered = []; // teardown drops un-flushed frames (§3.7)
    this.bufferedBytes = 0;
  }

  pendingBytes(): number {
    return this.bufferedBytes;
  }

  /** Serialize offers+flushes through one promise chain so encrypted
   * messages (and their L2 counters) leave in dispatch order. */
  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.chain.then(step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private scheduleWindow(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(1, this.windowMs) as never);
    this.timer.unref?.(); // broker `scheduleUnref` posture (§C): windows never hold the event loop
  }

  private cancelWindow(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private capsReached(): boolean {
    return this.buffered.length >= this.maxBatchFrames
      || this.bufferedBytes >= this.maxBatchBytes
      || this.bufferedBytes + BATCH_ENVELOPE_RESERVED_BYTES >= MAX_PLAINTEXT_FRAME_BYTES;
  }

  private async flushBuffer(): Promise<void> {
    this.cancelWindow();
    if (this.buffered.length === 0) return;
    const take = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.lastFlushStamp = this.readClock();
    await this.send(encodeBatchContainer(take));
  }

  private async offerNowBytes(bytes: Buffer): Promise<void> {
    if (this.disposed) return;
    const type = bytes[0]! & 0x7f;
    if (!BATCH_BUFFERED_TYPES.has(type)) {
      await this.flushBuffer(); // setup/teardown/keepalive flush the buffer first (per-stream order)
      await this.send(bytes);
      return;
    }
    this.buffered.push(bytes);
    this.bufferedBytes += bytes.length + BATCH_ENVELOPE_RESERVED_BYTES;
    if (this.capsReached()) {
      await this.flushBuffer(); // cap flush: everything keeps its dispatch order
      return;
    }
    if (this.readClock() - this.lastFlushStamp >= this.windowMs) {
      await this.flushBuffer(); // leading edge ships instantly (time-to-first-token)
      return;
    }
    this.scheduleWindow();
  }
}
