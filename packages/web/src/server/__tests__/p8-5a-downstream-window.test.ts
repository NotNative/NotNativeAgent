// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5a window heuristics gates (doc 08 Â§3.5/Â§3.8, E-08-27 closure) for
 * the adaptive downstream window. Frame shape: 8187-byte payload + 5-byte
 * header = exactly 8192 raw bytes ("tiles"); the start window is 8 tiles
 * (64 KiB) and each grow doubles the tile count (cap 1 MiB). GROW Ã—2 only
 * when a head BLOCKED by the window latched the latch AND the ack delivery
 * delay is near the best observed RTT (â‰¤ minRtt + 50 ms); HALVE when the
 * delay exceeds minRtt + 100 ms; one adjustment per checkpointed window
 * of acks (checkpoint = latest ack position + window); ack-law violations
 * fail the channel once; cancelled streams release queued work only.
 */
import { describe, expect, it } from 'vitest';
import { TunnelFrameType, encodeTunnelFrame } from '../lib/relay/tunnel-codec.ts';
import {
  createDownstreamScheduler, INITIAL_WINDOW_BYTES, MAX_WINDOW_BYTES, SchedulerError,
} from '../lib/relay/downstream.ts';

const PAYLOAD_BYTES = 8 * 1024 - 5;
const RAW = 8 * 1024;
const STREAM_A = 3;
const STREAM_B = 5;
const FAST_MS = 2;
const SLOW_MS = 400;

interface Rig {
  scheduler: ReturnType<typeof createDownstreamScheduler>;
  failures: string[];
  tick: (ms: number) => void;
  frame: (streamId: number) => { type: number; streamId: number; hasMore: boolean; payload: Buffer };
  /** Ack |tiles| more raw frame bytes cumulatively (tile-exact). */
  ack: (tiles: number) => void;
  /** Ack an exact cumulative raw position (violations test). */
  ackRawCumulative: (rawBytes: number) => void;
  /** Sends |tiles| frames sequentially (each emitted into the ledger). */
  stream: (tiles: number, streamId?: number) => Promise<void>;
  startOne: (streamId?: number) => Promise<void>;
  window: () => number;
  outstanding: () => number;
}

function makeRig(): Rig {
  const clock = { now: 1_000_000 };
  let ackedRaw = 0;
  const failures: string[] = [];
  const scheduler = createDownstreamScheduler({
    emit: (frameBytes) => { void frameBytes.length; },
    streamZeroEmit: (frameBytes) => { void frameBytes.length; },
    onError: (error) => { failures.push(error.message); },
    now: (): number => clock.now,
  });
  const rig: Rig = {
    scheduler,
    failures,
    tick: (ms) => { clock.now += ms; },
    frame: (streamId) => ({ type: TunnelFrameType.HttpBody, streamId, hasMore: false, payload: Buffer.alloc(PAYLOAD_BYTES) }),
    ack: (tiles) => { rig.ackRawCumulative(ackedRaw + tiles * RAW); },
    ackRawCumulative: (rawBytes) => {
      ackedRaw = rawBytes;
      const payload = Buffer.alloc(8);
      payload.writeBigUInt64BE(BigInt(rawBytes), 0);
      scheduler.onAck(payload);
    },
    stream: async (tiles, streamId = STREAM_A) => {
      for (let i = 0; i < tiles; i += 1) await rig.scheduler.send(rig.frame(streamId));
    },
    startOne: (streamId = STREAM_A) => {
      return rig.scheduler.send(rig.frame(streamId)).then(
        (): void => undefined,
        (error: unknown) => { if (error instanceof SchedulerError) return; throw error; },
      );
    },
    window: () => scheduler.stats().windowBytes,
    outstanding: () => scheduler.stats().outstanding,
  };
  return rig;
}

async function drainTasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Send+ack |tiles| tiles at a constant (near-best) RTT without ever blocking the window. */
async function ride(rig: Rig, tiles: number, ms = FAST_MS): Promise<void> {
  for (let i = 0; i < tiles; i += 1) {
    await rig.stream(1);
    rig.tick(ms);
    rig.ack(1);
  }
}

describe('adaptive downstream window (Â§3.5/Â§3.8, E-08-27)', () => {
  it('the start window only seeds telemetry when nothing ever blocked: no adjust', async () => {
    const rig = makeRig();
    await rig.stream(7); // 57344 â‰¤ 65536: the pump never skips a head
    rig.tick(FAST_MS);
    rig.ack(7); // sample 2ms â†’ minRtt 2; checkpoint advances; latch never set
    expect(rig.window()).toBe(INITIAL_WINDOW_BYTES);
    expect(rig.failures).toEqual([]);
    expect(rig.outstanding()).toBe(0);
  });

  it('grow Ã—2 when a blocked head latched AND the ack RTT is near the best observed', async () => {
    const rig = makeRig();
    await rig.stream(8); // fills the 64 KiB window exactly (65536)
    const blocked = rig.startOne(); // the 9th head: 73728 > 65536 â†’ LATCH, stays queued
    await drainTasks();
    expect(rig.outstanding()).toBe(8);
    rig.tick(FAST_MS);
    rig.ack(8); // sample 2 â†’ minRtt 2; latch â†’ GROW Ã—2; checkpoint = 65536 + 131072
    await blocked; // the queued head admitted again (pump reopened by the ack)
    expect(rig.window()).toBe(2 * INITIAL_WINDOW_BYTES);
    expect(rig.outstanding()).toBe(1);
    expect(rig.failures).toEqual([]);
  });

  it('one adjustment per checkpointed window: a re-latch inside the window waits for the crossing', async () => {
    const rig = makeRig();
    await rig.stream(8);
    const first = rig.startOne();
    await drainTasks();
    rig.tick(FAST_MS);
    rig.ack(8); // GROW Ã—2 (latch consumed); checkpoint = 65536 + 131072 = 196608
    await first;
    expect(rig.window()).toBe(2 * INITIAL_WINDOW_BYTES);
    // `first` counts as one tile: 15 more tiles top the grown window exactly.
    await rig.stream(15); // outstanding now 16 tiles = 131072
    const second = rig.startOne(); // re-latch inside the same checkpoint window
    await drainTasks();
    rig.tick(FAST_MS);
    rig.ack(15); // 188416 < checkpoint: latch armed, near-best RTT â€” NO adjust yet
    await second; // the queued head admitted (16 tiles is one tile past the 15 acked)
    expect(rig.window()).toBe(2 * INITIAL_WINDOW_BYTES);
    rig.ack(1); // crossing 196608: the pending adjustment fires NOW (latch + near-best) â†’ 262144
    expect(rig.window()).toBe(4 * INITIAL_WINDOW_BYTES);
    expect(rig.failures).toEqual([]);
  });

  it('one far-delayed window of acks halves the grown window; the floor holds the start window', async () => {
    const rig = makeRig();
    await rig.stream(8);
    const first = rig.startOne();
    await drainTasks();
    rig.tick(FAST_MS);
    rig.ack(8); // grow â†’ 131072 (checkpoint = 65536 + 131072 = 196608)
    await first;
    await rig.stream(15); // outstanding 16 tiles = 131072
    const second = rig.startOne();
    await drainTasks();
    rig.tick(FAST_MS);
    rig.ack(16); // crossing 196608 â†’ grow â†’ 262144 (checkpoint = 196608 + 262144 = 458752)
    await second;
    expect(rig.window()).toBe(4 * INITIAL_WINDOW_BYTES);
    // Riding near-best acks alone never adjusts the window (latch absent);
    // the halve fires at the NEXT checkpoint crossing with a slow sample.
    await ride(rig, 31); // acked 458752 â†’ 712704 (< checkpoint 720896)
    expect(rig.window()).toBe(4 * INITIAL_WINDOW_BYTES);
    await rig.stream(1);
    rig.tick(SLOW_MS); // sample 402ms > minRtt(2) + 100
    rig.ack(1); // crossing 720896 â†’ HALVE 262144 â†’ 131072; checkpoint = 851968
    expect(rig.window()).toBe(2 * INITIAL_WINDOW_BYTES);
    await ride(rig, 15); // acked 720896 â†’ 843776 (< checkpoint 851968)
    expect(rig.window()).toBe(2 * INITIAL_WINDOW_BYTES);
    await rig.stream(1);
    rig.tick(SLOW_MS * 2);
    rig.ack(1); // crossing 851968 â†’ HALVE 131072 â†’ 65536 (the floor holds)
    expect(rig.window()).toBe(INITIAL_WINDOW_BYTES);
    expect(rig.failures).toEqual([]);
  });

  it('ack-law violations fail the channel exactly once (regression/beyond/off-boundary/short)', async () => {
    const regression = makeRig();
    await regression.stream(1);
    regression.ack(1);
    regression.ackRawCumulative(1); // dropped backwards â†’ regression/duplicate
    expect(regression.failures[0]).toContain('regression or duplicate');
    const beyond = makeRig();
    beyond.ack(3); // nothing sent yet â†’ beyond sent bytes
    expect(beyond.failures[0]).toContain('beyond sent bytes');
    const offBoundary = makeRig();
    await offBoundary.stream(1);
    offBoundary.ackRawCumulative(RAW - 1); // inside a frame â†’ off boundary
    expect(offBoundary.failures[0]).toContain('off frame boundary');
    const shortPayload = makeRig();
    shortPayload.scheduler.onAck(Buffer.alloc(4));
    expect(shortPayload.failures[0]).toContain('payload too short');
    for (const rig of [regression, beyond, offBoundary, shortPayload]) {
      await expect(rig.scheduler.send(rig.frame(STREAM_B))).rejects.toThrow(SchedulerError);
    }
  });

  it('cancelling a stream releases its queued work only; the outstanding ledger stays lawful', async () => {
    const rig = makeRig();
    await rig.stream(1); // emitted + outstanding
    const queued = rig.scheduler.send(rig.frame(STREAM_A));
    rig.scheduler.cancelStream(STREAM_A);
    await expect(queued).rejects.toThrow(/stream cancelled/);
    rig.tick(FAST_MS);
    rig.ack(1); // the outstanding (sent) frame acks on the exact boundary
    expect(rig.failures).toEqual([]);
    expect(rig.outstanding()).toBe(0);
    expect(MAX_WINDOW_BYTES).toBe(1024 * 1024);
  });
});
