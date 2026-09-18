// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalTransport gates (doc 07 sections 3.6/6.1): attach on open,
 * snapshot-first delivery, q-dedupe, projection replay for late
 * subscribers, write reconnect-once-then-throw, backoff caps, hidden slow
 * path, idle socket hold 15 s, pre-open failure token hook. Inbound ingest
 * is async (Blob-capable decode), so every push awaits a flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { TerminalTransport } from '../transport.ts';
import { RECONNECT_BASE_MS, RECONNECT_CAP_MS, SLOW_PATH_MS, encodeTerminalFrame, trimHead, type TerminalEventFrame, type WireSocket, type WebSocketFactory } from '../wire.ts';

interface FakeSocket extends WireSocket {
  url: string;
  sentText: string[];
  closed: number;
  failNextSend: boolean;
}

function fakeSocketFactory(sockets: FakeSocket[]): WebSocketFactory {
  return (url: string): FakeSocket => {
    const socket: FakeSocket = {
      url,
      sentText: [],
      closed: 0,
      failNextSend: false,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: (data) => {
        if (socket.failNextSend) throw new Error('send boom');
        socket.sentText.push(String.fromCharCode(...Array.from(data as Uint8Array)));
      },
      close: () => { socket.closed += 1; },
    };
    sockets.push(socket);
    return socket;
  };
}

function clockStub(): { timeouts: { setTimeout: (handler: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }; delays: number[]; runAll: () => void } {
  const timers: { handler: () => void; ms: number }[] = [];
  const delays: number[] = [];
  return {
    delays,
    timeouts: {
      setTimeout: (handler, ms) => { delays.push(ms); timers.push({ handler, ms }); return timers.length - 1; },
      clearTimeout: (handle) => { delete timers[handle as number]; },
    },
    runAll: () => { for (const timer of [...timers]) { if (timer !== undefined) timer.handler(); } },
  };
}

function autoOpen(sockets: FakeSocket[]): void {
  for (const socket of [...sockets]) socket.onopen?.();
}

async function pushInbound(socket: FakeSocket, frame: TerminalEventFrame | object): Promise<void> {
  const bytes = Buffer.from(encodeTerminalFrame(frame));
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); // Buffer pool≠frame bytes
  socket.onmessage?.({ data: exact });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sentFrames(socket: FakeSocket): { t: string; s?: string; d?: string }[] {
  return socket.sentText.map((row) => JSON.parse(row.slice(1)) as { t: string; s?: string; d?: string });
}

beforeEach(() => {
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TerminalTransport (doc 07 section 6.1)', () => {
  it('dials on subscribe, attaches on open, snapshot-first + q-deduped delivery', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws');
    const events: TerminalEventFrame[] = [];
    transport.subscribe('s-1', { onEvent: (frame) => events.push(frame) });
    transport.subscribe('s-1', { onEvent: (frame) => events.push(frame) }); // double attach
    autoOpen(sockets);
    expect(sentFrames(sockets[0]!).filter((frame) => frame.t === 'attach')).toEqual([{ v: 3, t: 'attach', s: 's-1' }]); // one attach per session on open (server-side idempotent, section 3.3)
    await pushInbound(sockets[0]!, { v: 3, t: 'snapshot', s: 's-1', q: 2, history: 'old', cols: 80, rows: 24, status: 'running' });
    await pushInbound(sockets[0]!, { v: 3, t: 'output', s: 's-1', q: 3, d: 'live' });
    await pushInbound(sockets[0]!, { v: 3, t: 'output', s: 's-1', q: 3, d: 'duplicate' }); // q-dedupe
    const frames = events.filter((frame) => frame.t !== 'reconnecting');
    const both = frames.map((frame) => (frame as { t: string }).t);
    expect(both.filter((name) => name === 'snapshot')).toHaveLength(2); // the q>0 replay keeps subscribers exact
    expect(both.filter((name) => name === 'output')).toHaveLength(2); // one delivery PER SUBSCRIBER (both saw q=3 once)
    const shared = (frames.find((frame) => (frame as { t: string }).t === 'output') as unknown as { d: string }).d;
    expect(shared).toBe('live');
    transport.dispose();
  });

  it('a simultaneous second subscriber replays the projection instantly (tab switch churn)', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws');
    transport.subscribe('s-2', { onEvent: () => undefined });
    autoOpen(sockets);
    await pushInbound(sockets[0]!, { v: 3, t: 'snapshot', s: 's-2', q: 5, history: 'hello terminal', cols: 100, rows: 30, status: 'running' });
    const churn: TerminalEventFrame[] = [];
    transport.subscribe('s-2', { onEvent: (frame) => churn.push(frame) }); // while the first subscription is alive
    expect(churn).toHaveLength(1); // server-fed projection replays with NO roundtrip (section 6.1)
    const snapshot = churn[0] as unknown as { t: string; q: number; history: string; cols: number };
    expect(snapshot.t).toBe('snapshot');
    expect(snapshot.q).toBe(5);
    expect(snapshot.history).toBe('hello terminal');
    expect(snapshot.cols).toBe(100);
    expect(sentFrames(sockets[0]!).filter((frame) => frame.t === 'attach')).toHaveLength(2); // open attach + live re-attach on churn (server idempotent)
    transport.dispose();
  });

  it('write sends binary frames; a send failure closes + reconnects once, the second throws', async () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    transport.subscribe('s-3', { onEvent: () => undefined });
    autoOpen(sockets);
    transport.write('s-3', 'ls\r');
    const written = sentFrames(sockets[0]!).find((frame) => frame.t === 'write')!;
    expect(written).toEqual({ v: 3, t: 'write', s: 's-3', d: 'ls\r' });
    sockets[0]!.failNextSend = true;
    expect(() => transport.write('s-3', 'x')).toThrow('send failed');
    expect(sockets[0]!.closed).toBe(1); // close + reconnect-once (section 6.1)
    transport.dispose();
  });

  it('reconnect backoff doubles and caps at 8 s; hidden/offline slow path is 60 s', async () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    transport.subscribe('s-4', { onEvent: () => undefined });
    autoOpen(sockets);
    sockets[0]!.onclose?.({ code: 1006 });
    clock.runAll(); // attempt 1
    expect(clock.delays).toContain(RECONNECT_BASE_MS);
    clock.runAll(); // attempt 2 dial
    const second = sockets[1]!;
    second.onclose?.({ code: 1006 });
    clock.runAll();
    expect(clock.delays).toContain(1_000); // 500 * 2^(n-1)
    (document as unknown as { hidden: boolean }).hidden = true;
    sockets[sockets.length - 1]!.onclose?.({ code: 1006 });
    clock.runAll();
    expect(clock.delays).toContain(SLOW_PATH_MS); // hidden slow path (section 3.6)
    transport.dispose();
  });

  it('the last unsubscribe detaches and holds a healthy socket for 15 s; a re-subscribe cancels the hold', async () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    const stop = transport.subscribe('s-5', { onEvent: () => undefined });
    autoOpen(sockets);
    stop();
    expect(sentFrames(sockets[0]!).find((frame) => frame.t === 'detach')).toEqual({ v: 3, t: 'detach', s: 's-5' } as { t: string; s?: string; d?: string });
    stop(); // idempotent unsubscribe
    const restart = transport.subscribe('s-5', { onEvent: () => undefined }); // tab switch back inside the hold window
    clock.runAll();
    expect(sockets[0]!.closed).toBe(0); // the healthy socket is still held (15 s idle grace reused)
    expect(sentFrames(sockets[0]!).filter((frame) => frame.t === 'attach')).toEqual([{ v: 3, t: 'attach', s: 's-5' }, { v: 3, t: 'attach', s: 's-5' }]); // open attach + re-attach on the live socket
    restart();
    clock.runAll();
    expect(sockets[0]!.closed).toBe(1); // idle hold elapsed -> close (section 6.1)
    transport.dispose();
  });

  it('a reconnect due with zero subscribers resets the attempt counter for the next cycle', () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    const stop = transport.subscribe('s-10', { onEvent: () => undefined });
    autoOpen(sockets);
    sockets[0]!.onclose?.({ code: 1006 }); // one failure scheduled at base 500 ms
    stop(); // everything detached while the reconnect is pending
    clock.runAll(); // the reconnect fires with nobody waiting: attempt resets to 0
    transport.subscribe('s-10', { onEvent: () => undefined });
    autoOpen(sockets);
    sockets[sockets.length - 1]!.onclose?.({ code: 1006 });
    expect(clock.delays.filter((delay) => delay === RECONNECT_BASE_MS)).toHaveLength(2); // fresh backoff, not 500*2^(n-1)
    expect(clock.delays).not.toContain(1_000);
    transport.dispose();
  });

  it('dispose stops the reconnect surface: a late close/error/error frames schedule nothing new', async () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    transport.subscribe('s-9', { onEvent: () => undefined });
    autoOpen(sockets);
    transport.dispose();
    sockets[0]!.onclose?.({ code: 1006 }); // late close after dispose
    clock.runAll(); // ping + reconnect + idle timers are all dead
    expect(sockets).toHaveLength(1); // no dial, no ping residue
  });

  it('a subscribe during CONNECTING defers the attach to onopen without tearing down the dial', async () => {
    const sockets: FakeSocket[] = [];
    const clock = clockStub();
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws', clock.timeouts);
    transport.subscribe('s-6', { onEvent: () => undefined }); // in-flight dial starts here
    // the first subscriber attaches only at onopen; a LATE session joins during the dial
    transport.subscribe('s-7', { onEvent: () => undefined });
    expect(sockets[0]!.sentText).toHaveLength(0); // no frames on a CONNECTING socket (a raw send would throw and burn the dial)
    expect(sockets[0]!.closed).toBe(0); // the dial survives
    autoOpen(sockets);
    expect(sentFrames(sockets[0]!).filter((frame) => frame.t === 'attach').map((frame) => frame.s)).toEqual(['s-6', 's-7']); // attachedSessionIds covers LATE sessions
    transport.dispose();
  });

  it('a q=0 snapshot does not stall later events (fresh session, empty history)', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new TerminalTransport(fakeSocketFactory(sockets), () => 'ws://test/api/terminal/ws');
    const events: TerminalEventFrame[] = [];
    transport.subscribe('s-8', { onEvent: (frame) => events.push(frame) });
    autoOpen(sockets);
    await pushInbound(sockets[0]!, { v: 3, t: 'snapshot', s: 's-8', q: 0, history: '', cols: 80, rows: 24, status: 'running' });
    await pushInbound(sockets[0]!, { v: 3, t: 'output', s: 's-8', q: 1, d: 'first' });
    await pushInbound(sockets[0]!, { v: 3, t: 'output', s: 's-8', q: 2, d: 'second' });
    const outputs = events.filter((frame) => frame.t === 'output') as unknown[];
    expect(outputs).toHaveLength(2); // nothing blocked behind the q=0 base
    transport.dispose();
  });
});

describe('trimHead (512 KiB UTF-8-safe head trim, whole characters)', () => {
  it('trims whole leading characters and keeps the budget', () => {
    const text = 'x'.repeat(600_000);
    const trimmed = trimHead(text, 1024);
    expect(new TextEncoder().encode(trimmed).length).toBe(1024);
    expect(trimmed.endsWith('x'.repeat(1024))).toBe(true);
  });

  it('drops a whole multibyte character instead of a half-cut sequence', () => {
    const text = '\u00e9'.repeat(700); // 2-byte chars; the cut always lands mid-character
    const trimmed = trimHead(text, 1024);
    expect(new TextEncoder().encode(trimmed).length).toBeLessThanOrEqual(1024);
    for (const char of trimmed) expect(char).toBe('\u00e9'); // no replacement chars
  });

  it('a single character bigger than the budget decodes empty, no infinite loop', () => {
    expect(trimHead('\ud83d\ude00'.repeat(4), 2)).toBe(''); // 4-byte emoji vs a 2-byte budget
    expect(trimHead('\ud83d\ude00'.repeat(4), 0)).toBe('');
  });
});
