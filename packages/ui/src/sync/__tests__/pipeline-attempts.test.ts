// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { PipelineQueues } from '../pipeline-queues.ts';
import { attemptSse, attemptWs, createDeliver, processSseFrame } from '../pipeline-attempts.ts';
import { replayCursorAfterFlush, shouldSkipConnectedResync } from '../event-pipeline.ts';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const opener = (status?: string) => `data: ${JSON.stringify({ payload: {
  id: 'receipt', type: 'server.connected', properties: status ? { replayStatus: status } : {},
} })}\n\n`;
const event = (id: string) => `id: ${id}\ndata: ${JSON.stringify({ payload: {
  id, type: 'session.updated', properties: {},
} })}\n\n`;

function streamResponse(text: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }), { status: 200 });
}

function streamContext(initial: string | null = null) {
  let cursor = initial;
  const received: string[] = [];
  const queues = new PipelineQueues((_directory, events) => received.push(...events.map((item) => item.type)));
  return {
    ctx: {
      lastEventId: () => cursor,
      setLastEventId: (id: string | null) => { cursor = id; },
      noteActivity: () => undefined,
      queues,
    },
    cursor: () => cursor,
    received,
  };
}

describe('SSE replay cursor', () => {
  it('does not replace a durable cursor with a non-replayable connection receipt', () => {
    let cursor: string | null = 'evt_previous';
    const queues = new PipelineQueues(() => undefined);
    const ctx = {
      lastEventId: () => cursor,
      setLastEventId: (id: string | null) => { cursor = id; },
      noteActivity: () => undefined,
      queues,
    };
    const deliver = createDeliver(ctx);
    processSseFrame(ctx, deliver, 'data: {"payload":{"id":"evt_receipt","type":"server.connected","properties":{}}}');
    expect(cursor).toBe('evt_previous');
    expect(replayCursorAfterFlush(cursor, [{ id: 'evt_receipt', type: 'server.connected' }])).toBe('evt_previous');
    processSseFrame(ctx, deliver, 'id: evt_durable\ndata: {"payload":{"id":"evt_durable","type":"session.updated","properties":{}}}');
    expect(cursor).toBe('evt_durable');
    processSseFrame(ctx, deliver, 'id: malicious\ndata: {broken');
    processSseFrame(ctx, deliver, 'id: mismatch\ndata: {"payload":{"id":"different","type":"session.updated","properties":{}}}');
    processSseFrame(ctx, deliver, 'id: malformed\ndata: {"payload":{"id":"malformed","type":42,"properties":{}}}');
    expect(cursor).toBe('evt_durable');
  });

  it('waits for a complete opener and retains replay cursor', async () => {
    const state = streamContext('old');
    let release!: () => void;
    const recovery = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(opener('complete') + event('next')));
    const established = vi.fn(() => recovery);
    const attempt = attemptSse(state.ctx, '/api/global/event', new AbortController().signal, established);
    await vi.waitFor(() => expect(established).toHaveBeenCalledWith({ replayReset: false, replayStatus: 'complete', explicitGap: false }));
    expect(state.cursor()).toBe('old');
    expect(state.received).toEqual([]);
    release();
    await attempt;
    state.ctx.queues.flushAll();
    expect(state.cursor()).toBe('next');
    expect(state.received).toContain('session.updated');
  });

  it('accepts a native transcript preview larger than 64 KiB', async () => {
    const state = streamContext('old');
    const large = `id: next\ndata: ${JSON.stringify({ payload: {
      id: 'next', type: 'message.part.updated', properties: { part: { text: 'x'.repeat(70_000) } },
    } })}\n\n`;
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(opener('complete') + large));
    await attemptSse(state.ctx, '/api/global/event', new AbortController().signal, vi.fn());
    expect(state.cursor()).toBe('next');
  });

  it('clears an evicted cursor and waits for recovery before later frames', async () => {
    const state = streamContext('evicted');
    let release!: () => void;
    const recovery = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(opener('gap') + event('next')));
    const established = vi.fn(() => recovery);
    const attempt = attemptSse(state.ctx, '/api/global/event', new AbortController().signal, established);
    await vi.waitFor(() => expect(established).toHaveBeenCalledWith({ replayReset: true, replayStatus: 'gap', explicitGap: true }));
    expect(state.cursor()).toBeNull();
    expect(state.received).toEqual([]);
    release();
    await attempt;
    expect(state.cursor()).toBe('next');
  });

  it('treats a missing replay status as a gap and rejects frames before the opener', async () => {
    const state = streamContext('old');
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(opener()));
    const established = vi.fn();
    await attemptSse(state.ctx, '/api/global/event', new AbortController().signal, established);
    expect(established).toHaveBeenCalledWith({ replayReset: true, replayStatus: 'gap', explicitGap: false });
    expect(state.cursor()).toBeNull();
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(opener('invented')));
    await attemptSse(state.ctx, '/api/global/event', new AbortController().signal, established);
    expect(established).toHaveBeenLastCalledWith({ replayReset: true, replayStatus: 'gap', explicitGap: false });
    vi.mocked(runtimeFetch).mockResolvedValueOnce(streamResponse(event('unexpected')));
    await expect(attemptSse(state.ctx, '/api/global/event', new AbortController().signal, established)).rejects.toThrow('sse_missing_opener');
    expect(state.cursor()).toBeNull();
  });

  it('bounds a stream that never sends an opener', async () => {
    const state = streamContext('old');
    vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({}), { status: 200 }));
    vi.useFakeTimers();
    try {
      const attempt = attemptSse(state.ctx, '/api/global/event', new AbortController().signal, vi.fn());
      const rejection = expect(attempt).rejects.toThrow('sse_opener_timeout');
      await vi.advanceTimersByTimeAsync(5_001);
      await rejection;
      expect(state.cursor()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnect recovery', () => {
  it('requires a snapshot on SSE reconnect even after a recent boot', () => {
    expect(shouldSkipConnectedResync(true, false, false, 'sse', false)).toBe(true);
    expect(shouldSkipConnectedResync(false, false, false, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(true, true, false, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(false, false, true, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(false, false, false, 'ws', true)).toBe(true);
    expect(shouldSkipConnectedResync(false, false, false, 'sse', true, 'complete')).toBe(false);
    expect(shouldSkipConnectedResync(false, false, true, 'sse', true, 'gap')).toBe(false);
  });
});

describe('WebSocket recovery ordering', () => {
  it('holds live frames until the ready callback finishes recovery', async () => {
    let socket!: EventTarget & { close: () => void };
    class FakeSocket extends EventTarget {
      constructor() { super(); socket = this; }
      close() { this.dispatchEvent(new Event('close')); }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    try {
      const state = streamContext('old');
      let release!: () => void;
      const recovery = new Promise<void>((resolve) => { release = resolve; });
      const attempt = attemptWs(state.ctx, 'ws://example.test', new AbortController().signal, 5_000, () => recovery);
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ready', replayReset: true }) }));
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'event', eventId: 'new', payload: { type: 'session.updated', properties: {} },
      }) }));
      await Promise.resolve();
      expect(state.cursor()).toBeNull();
      release();
      await vi.waitFor(() => expect(state.cursor()).toBe('new'));
      socket.close();
      await expect(attempt).resolves.toEqual({ status: undefined });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
