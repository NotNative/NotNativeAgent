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
 * Windowing: fixed start 64 KiB, hard cap 1 MiB (E-08-27: the adaptive
 * grow/halve window heuristics are deferred; byte accounting stays
 * identical). Sent-but-unacked bytes may never exceed the window; an ack
 * releases that credit for the next sends. A cumulative ack must be
 * strictly increasing (no duplicate/regression), never beyond sent bytes,
 * and land exactly on an outstanding frame boundary - any violation fails
 * the channel via `onError`.
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
}): DownstreamScheduler {
  return new DownstreamSchedulerImpl(options);
}

class DownstreamSchedulerImpl implements DownstreamScheduler {
  private readonly options: {
    emit: (frameBytes: Buffer) => void;
    streamZeroEmit: (frameBytes: Buffer) => void;
    onError: (error: Error) => void;
  };
  private readonly queues = new Map<number, QueuedEntry[]>();
  private readonly outstanding: { streamId: number; bytes: number }[] = [];
  private windowBytes = INITIAL_WINDOW_BYTES;
  private queuedBytes = 0;
  private queuedFrames = 0;
  private ackedBytes = 0; // cumulative acked RAW frame bytes (ack ledger covers all nonzero streams)
  private outstandingBytes = 0; // raw bytes of sent-but-unacked nonzero-stream frames
  private closed = false;
  private pumpScheduled = false;

  constructor(options: { emit: (frameBytes: Buffer) => void; streamZeroEmit: (frameBytes: Buffer) => void; onError: (error: Error) => void }) {
    this.options = options;
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
    while (consumed > 0 && this.outstanding.length > 0) {
      const head = this.outstanding[0]!;
      if (head.bytes > consumed) {
        this.failChannel(new SchedulerError('DeliveryAck off frame boundary'));
        return;
      }
      consumed -= head.bytes;
      this.outstandingBytes -= head.bytes;
      this.outstanding.shift();
    }
    if (consumed !== 0) {
      this.failChannel(new SchedulerError('DeliveryAck off frame boundary'));
      return;
    }
    this.schedulePump();
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
    for (const streamId of [...this.queues.keys()]) {
      const queue = this.queues.get(streamId);
      if (queue === undefined) continue;
      if (queue.length === 0) {
        this.queues.delete(streamId);
        continue;
      }
      const head = queue[0]!;
      if (streamId !== STREAM_ZERO && this.outstandingBytes + head.bytes.length > this.windowBytes) continue;
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
    this.outstanding.push({ streamId, bytes: entry.bytes.length });
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
