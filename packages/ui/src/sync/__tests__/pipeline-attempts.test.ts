// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PipelineQueues } from '../pipeline-queues.ts';
import { createDeliver, processSseFrame } from '../pipeline-attempts.ts';
import { replayCursorAfterFlush, shouldSkipConnectedResync } from '../event-pipeline.ts';

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
  });
});

describe('reconnect recovery', () => {
  it('requires a snapshot on SSE reconnect even after a recent boot', () => {
    expect(shouldSkipConnectedResync(true, false, false, 'sse', false)).toBe(true);
    expect(shouldSkipConnectedResync(false, false, false, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(true, true, false, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(false, false, true, 'sse', true)).toBe(false);
    expect(shouldSkipConnectedResync(false, false, false, 'ws', true)).toBe(true);
  });
});
