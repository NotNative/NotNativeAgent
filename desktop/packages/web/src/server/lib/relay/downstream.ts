// SPDX-License-Identifier: Apache-2.0
/**
 * Relay §3.8 downstream scheduler (host->client credit control): per-
 * stream FIFO queues with round-robin rounds; `send(frame)` resolves once
 * the frame fits inside the connection-wide credit window, so HTTP
 * response readers stop before an unbounded plaintext queue builds.
 *
 * Ack unit (§3.8): the client's DeliveryAck payload is 8 bytes big-endian
 * cumulative RAW tunnel-frame bytes over NONZERO streams only (the 5B
 * frame header included; batch envelopes, encryption overhead, and
 * stream-zero keepalives are excluded). Because the client's count never
 * covers stream zero, keepalive frames bypass the window and the ack
 * ledger entirely - they are emitted and resolved immediately, never held
 * as outstanding references.
 *
 * Windowing (E-08-27 heuristics, live since the client §3.10 slice):
 * start 64 KiB, hard cap 1 MiB. Grow ×2 only when the window itself
 * limited throughput AND the ack's delivery delay is near the best
 * observed RTT (`<= minRtt + 50 ms`); halve (floor 64 KiB) when the
 * delivery delay exceeds `minRtt + QUEUE_DELAY_TARGET_MS` (100 ms).
 * Adjustment happens once per window: the checkpoint is
 * `latestAckPosition + window` bytes of cumulative acks, not a per-frame
 * rule; a skipped head (window-limited) latches the only grow signal.
 * Sparse traffic cannot inflate the window for a later bulk burst; a
 * sudden bandwidth drop can delay in-flight bytes but cannot build an
 * unbounded backlog. Sent-but-unacked bytes may never exceed the window;
 * an ack releases that credit for the next sends. A cumulative ack must
 * be strictly increasing (no duplicate/regression), never beyond sent
 * bytes, and land exactly on an outstanding frame boundary - any
 * violation fails the channel via `onError`.
 *
 * Queue caps: 4 MiB queued bytes / 4096 queued frames / 4096 outstanding
 * frames - exceeding any fails the channel. `cancelStream` releases only
 * QUEUED work for the stream; already-sent frames stay outstanding and
 * must still be ACKed (late frames of cancelled streams consumed credit).
 */
import { encodeTunnelFrame, type TunnelFrame } from './tunnel-codec.ts';

export const STREAM_ZERO = 0;
export const INITIAL_WINDOW_BYTES = 64 * 1024;
export const MAX_WINDOW_BYTES = 1024 * 1024;
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const MAX_QUEUE_FRAMES = 4096;
export const MAX_OUTSTANDING_FRAMES = 4096;
export const QUEUE_DELAY_TARGET_MS = 100;
export const WINDOW_GROW_RTT_SLACK_MS = 50;

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
  }
}

interface QueuedEntry {
  bytes: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface DownstreamScheduler {
  send(frame: TunnelFrame): Promise<void>;
  /** Terminal rows bypass the §3.8 queue (a release cancel cannot eat
   * them) but still ACCOUNT in the ledger: the client acks every decoded
   * nonzero frame, so an uncounted row would trip "beyond sent bytes".
   * Emitted synchronously; the outstanding slot keeps frame-boundary
   * validation exact. */
  sendNow(frame: TunnelFrame): void;
  onAck(payload: Buffer): void;
  cancelStream(streamId: number): void;
  dispose(): void;
  stats(): { queuedBytes: number; queuedFrames: number; outstanding: number; windowBytes: number };
}

const cancelledError = (): SchedulerError => new SchedulerError('stream cancelled');

export function createDownstreamScheduler(options: {
  emit: (frameBytes: Buffer) => void;
  streamZeroEmit: (frameBytes: Buffer) => void;
  onError: (error: Error) => void;
  now?: () => number;
}): DownstreamScheduler {
  return new DownstreamSchedulerImpl(options);
}

class DownstreamSchedulerImpl implements DownstreamScheduler {
  private readonly options: {
    emit: (frameBytes: Buffer) => void;
    streamZeroEmit: (frameBytes: Buffer) => void;
    onError: (error: Error) => void;
    now: () => number;
  };
  private readonly queues = new Map<number, QueuedEntry[]>();
  private readonly outstanding: { streamId: number; bytes: number; sentAt: number }[] = [];
  private windowBytes = INITIAL_WINDOW_BYTES;
  private queuedBytes = 0;
  private queuedFrames = 0;
  private ackedBytes = 0; // cumulative acked RAW frame bytes (ack ledger covers all nonzero streams)
  private outstandingBytes = 0; // raw bytes of sent-but-unacked nonzero-stream frames
  private minRttMs = Number.POSITIVE_INFINITY; // best observed delivery delay (ack RTT)
  private adjustCheckpointBytes = 0; // one adjustment opportunity per window of acks
  private windowLimitedSinceAdjust = false;
  private closed = false;
  private pumpScheduled = false;

  constructor(options: { emit: (frameBytes: Buffer) => void; streamZeroEmit: (frameBytes: Buffer) => void; onError: (error: Error) => void; now?: () => number }) {
    this.options = { now: options.now ?? ((): number => Date.now()), emit: options.emit, streamZeroEmit: options.streamZeroEmit, onError: options.onError };
  }

  async send(frame: TunnelFrame): Promise<void> {
    if (this.closed) throw new SchedulerError('scheduler closed');
    const bytes = encodeTunnelFrame(frame);
    if (this.queuedFrames + 1 > MAX_QUEUE_FRAMES || this.queuedBytes + bytes.length > MAX_QUEUE_BYTES) {
      this.failChannel(new SchedulerError('downstream queue cap exceeded'));
      throw new SchedulerError('downstream queue cap exceeded');
    }
    this.queuedBytes += bytes.length;
    this.queuedFrames += 1;
    return await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(frame.streamId) ?? [];
      queue.push({ bytes, resolve, reject });
      this.queues.set(frame.streamId, queue);
      this.schedulePump();
    });
  }

  sendNow(frame: TunnelFrame): void {
    if (this.closed) return;
    const bytes = encodeTunnelFrame(frame);
    if (frame.streamId !== STREAM_ZERO) {
      // Terminal rows may land during a cap-saturated channel; they ship
      // without the outstanding-cap check (the row must reach the client),
      // but the boundary bookkeeping stays exact so acks stay lawful.
      this.outstanding.push({ streamId: frame.streamId, bytes: bytes.length, sentAt: this.options.now() });
      this.outstandingBytes += bytes.length;
    }
    this.options.emit(bytes);
  }

  onAck(payload: Buffer): void {
    if (payload.length < 8) {
      this.failChannel(new SchedulerError('DeliveryAck payload too short'));
      return;
    }
    const count = Number(payload.readBigUInt64BE(0));
    if (!Number.isSafeInteger(count) || count <= this.ackedBytes) {
      this.failChannel(new SchedulerError('DeliveryAck regression or duplicate'));
      return;
    }
    if (count > this.ackedBytes + this.outstandingBytes) {
      this.failChannel(new SchedulerError('DeliveryAck beyond sent bytes'));
      return;
    }
    let consumed = count - this.ackedBytes;
    this.ackedBytes = count;
    let oldestSentAt: number | null = null;
    while (consumed > 0 && this.outstanding.length > 0) {
      const head = this.outstanding[0]!;
      if (head.bytes > consumed) {
        this.failChannel(new SchedulerError('DeliveryAck off frame boundary'));
        return;
      }
      if (oldestSentAt === null) oldestSentAt = head.sentAt;
      consumed -= head.bytes;
      this.outstandingBytes -= head.bytes;
      this.outstanding.shift();
    }
    if (consumed !== 0) {
      this.failChannel(new SchedulerError('DeliveryAck off frame boundary'));
      return;
    }
    this.onAckTelemetry(oldestSentAt);
    this.schedulePump();
  }

  /** E-08-27 adaptive window: the earliest consumed frame measures this
   * ack's delivery delay; minRtt accumulates the best observed. GROW x2
   * only when the window itself limited throughput with a near-best RTT
   * (<= minRtt + 50ms); HALVE when the delay exceeds minRtt + 100ms. The
   * adjustment runs ONCE per window of acks (checkpoint = latest ack
   * position + window), never per frame. A strictly increasing ack always
   * consumes at least one outstanding frame, so the measured sample is
   * always available on the lawful path. */
  private onAckTelemetry(oldestSentAt: number | null): void {
    if (oldestSentAt === null) return;
    const delay = Math.max(0, this.options.now() - oldestSentAt);
    this.minRttMs = Math.min(this.minRttMs, delay);
    if (this.ackedBytes < this.adjustCheckpointBytes) return;
    if (this.minRttMs === Number.POSITIVE_INFINITY) { this.adjustCheckpointBytes = this.ackedBytes + this.windowBytes; this.windowLimitedSinceAdjust = false; return; }
    if (this.windowLimitedSinceAdjust && delay <= this.minRttMs + WINDOW_GROW_RTT_SLACK_MS) {
      this.windowBytes = Math.min(MAX_WINDOW_BYTES, this.windowBytes * 2);
    } else if (delay > this.minRttMs + QUEUE_DELAY_TARGET_MS) {
      this.windowBytes = Math.max(INITIAL_WINDOW_BYTES, Math.floor(this.windowBytes / 2));
    }
    // The boundary bookkeeping uses the CURRENT window after the adjustment:
    // the next opportunity waits for one full (possibly grown/halved) window of acks.
    this.adjustCheckpointBytes = this.ackedBytes + this.windowBytes;
    this.windowLimitedSinceAdjust = false;
  }

  cancelStream(streamId: number): void {
    const queue = this.queues.get(streamId);
    if (queue === undefined) return;
    for (const entry of queue) {
      entry.reject(cancelledError());
      this.queuedBytes -= entry.bytes.length;
      this.queuedFrames -= 1;
    }
    this.queues.delete(streamId);
  }

  dispose(): void {
    this.closed = true;
    for (const queue of this.queues.values()) {
      for (const entry of queue) entry.reject(new SchedulerError('scheduler disposed'));
    }
    this.queues.clear();
    this.queuedBytes = 0;
    this.queuedFrames = 0;
  }

  stats(): { queuedBytes: number; queuedFrames: number; outstanding: number; windowBytes: number } {
    return { queuedBytes: this.queuedBytes, queuedFrames: this.queuedFrames, outstanding: this.outstanding.length, windowBytes: this.windowBytes };
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => this.pump());
  }

  /** Stream zero first each round (keepalives never starve, never wait on
   * credit), then one frame per nonzero stream; rounds repeat until a full
   * round moves nothing. A head that would overflow the window stays
   * queued at its stream front - smaller heads of other streams still get
   * their slot (round-robin fairness is never dropped with the frame). */
  private pump(): void {
    this.pumpScheduled = false;
    if (this.closed) return;
    while (this.pumpRound()) {
      // rounds repeat while any frame was taken
    }
  }

  private pumpRound(): boolean {
    let took = false;
    // Stream zero is selected FIRST every round (keepalives never starve,
    // never wait on credit), then one frame per nonzero stream.
    const zeroQueue = this.queues.get(STREAM_ZERO);
    if (zeroQueue !== undefined && zeroQueue.length > 0) {
      const head = zeroQueue[0]!;
      zeroQueue.shift();
      this.dispatch(STREAM_ZERO, head);
      took = true;
    }
    for (const [streamId, queue] of [...this.queues.entries()]) {
      if (queue.length === 0) {
        this.queues.delete(streamId);
        continue;
      }
      if (streamId === STREAM_ZERO) continue; // already handled above
      const head = queue[0]!;
      if (this.outstandingBytes + head.bytes.length > this.windowBytes) {
        this.windowLimitedSinceAdjust = true;
        continue;
      }
      queue.shift();
      this.dispatch(streamId, head);
      took = true;
    }
    return took;
  }

  private dispatch(streamId: number, entry: QueuedEntry): void {
    this.queuedBytes -= entry.bytes.length;
    this.queuedFrames -= 1;
    if (streamId === STREAM_ZERO) {
      try {
        this.options.streamZeroEmit(entry.bytes);
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
        this.failChannel(new SchedulerError('stream-zero send failed downstream'));
        return;
      }
      entry.resolve();
      return;
    }
    if (this.outstanding.length >= MAX_OUTSTANDING_FRAMES) {
      entry.reject(new SchedulerError('outstanding frame cap exceeded'));
      this.failChannel(new SchedulerError(`outstanding frame cap exceeded (${MAX_OUTSTANDING_FRAMES})`));
      return;
    }
    this.outstanding.push({ streamId, bytes: entry.bytes.length, sentAt: this.options.now() });
    this.outstandingBytes += entry.bytes.length;
    try {
      this.options.emit(entry.bytes);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      this.failChannel(new SchedulerError('send failed downstream'));
      return;
    }
    entry.resolve();
  }

  private failChannel(error: SchedulerError): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.queues.values()) {
      for (const entry of queue) entry.reject(error);
    }
    this.queues.clear();
    this.queuedBytes = 0;
    this.queuedFrames = 0;
    this.options.onError(error);
  }
}
