// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline queue gates (doc 04 §J.2 subset): the four coalescing keys, delta
 * concatenation, snapshot/idle barriers, per-directory flush frames
 * (one publish per frame), and bounded backoff computation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineQueues, coalescingKey, computeRetryDelay, isPermanent4xx, resolveEventDirectory } from '../pipeline-queues.ts';
import type { HarnessEvent } from '../../lib/nnd/events.ts';

const frameEvent = (type: string, properties: Record<string, unknown>, directory?: string): HarnessEvent => ({
  type,
  properties,
  ...(directory ? { directory } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pipeline queues', () => {
  it('coalesces session.status per session and session.updated per session in slot', () => {
    const published: { directory: string; events: HarnessEvent[] }[] = [];
    const queues = new PipelineQueues((directory, events) => published.push({ directory, events: [...events] }));
    queues.push(frameEvent('session.status', { sessionID: 's1', status: { type: 'busy' } }, 'D:\\work'));
    queues.push(frameEvent('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 2, message: 'm', next: 1 } }, 'D:\\work'));
    queues.push(frameEvent('session.status', { sessionID: 's2', status: { type: 'busy' } }, 'D:\\work'));
    expect(queues.frameMs()).toBe(33);
    vi.advanceTimersByTime(34);
    expect(published).toHaveLength(1);
    expect(published[0]!.events).toHaveLength(2);
    const s1 = published[0]!.events.find((event) => (event.properties as { sessionID: string }).sessionID === 's1');
    expect((s1!.properties as { status: { type: string; attempt: number } }).status.attempt).toBe(2); // later replaces earlier
  });

  it('concatenates queued deltas on the same (message, part, field) key', () => {
    const published: HarnessEvent[][] = [];
    const queues = new PipelineQueues((_, events) => published.push([...events]));
    const delta = (text: string): HarnessEvent => frameEvent('message.part.delta', { messageID: 'm1', partID: 'p1', field: 'text', delta: text }, 'D:\\work');
    queues.push(delta('Hel'));
    queues.push(delta('lo w'));
    queues.push(delta('orld'));
    vi.advanceTimersByTime(34);
    expect(published).toHaveLength(1);
    expect(published[0]).toHaveLength(1);
    expect(published[0]![0]!.properties).toMatchObject({ delta: 'Hello world' });
  });

  it('drops pending delta keys when a full part snapshot arrives (barrier)', () => {
    const published: HarnessEvent[][] = [];
    const queues = new PipelineQueues((_, events) => published.push([...events]));
    queues.push(frameEvent('message.part.delta', { messageID: 'm1', partID: 'p1', field: 'text', delta: 'stale' }, 'D:\\work'));
    queues.push(frameEvent('message.part.updated', { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'fresh' } }, 'D:\\work'));
    vi.advanceTimersByTime(34);
    expect(published[0]).toHaveLength(1); // delta swallowed by the snapshot barrier
    expect(published[0]![0]!.type).toBe('message.part.updated');
  });

  it('session.idle clears the queued session.status; created/deleted also clear updated', () => {
    const published: HarnessEvent[][] = [];
    const queues = new PipelineQueues((_, events) => published.push([...events]));
    queues.push(frameEvent('session.status', { sessionID: 's1', status: { type: 'busy' } }, 'D:\\work'));
    queues.push(frameEvent('session.idle', { sessionID: 's1' }, 'D:\\work'));
    vi.advanceTimersByTime(34);
    expect(published[0]).toHaveLength(1);
    expect(published[0]![0]!.type).toBe('session.idle');

    published.length = 0;
    const second = new PipelineQueues((_, events) => published.push([...events]));
    second.push(frameEvent('session.updated', { info: { id: 's1' } }, 'D:\\work'));
    second.push(frameEvent('session.deleted', { sessionID: 's1' }, 'D:\\work'));
    vi.advanceTimersByTime(34);
    expect(published[0]).toHaveLength(1);
    expect(published[0]![0]!.type).toBe('session.deleted'); // updated swallowed by structural barrier
  });

  it('publishes one ordered frame per directory under burst (33ms trailing)', () => {
    const directories = new Map<string, number>();
    const queues = new PipelineQueues((directory) => directories.set(directory, (directories.get(directory) ?? 0) + 1));
    for (let i = 0; i < 10; i += 1) {
      queues.push(frameEvent('session.status', { sessionID: `s${i}`, status: { type: 'busy' } }, 'D:\\a'));
      queues.push(frameEvent('session.status', { sessionID: `s${i}`, status: { type: 'busy' } }, 'D:\\b'));
    }
    vi.advanceTimersByTime(34);
    expect(directories.get('D:\\a')).toBe(1);
    expect(directories.get('D:\\b')).toBe(1);
    vi.advanceTimersByTime(100);
    expect(directories.get('D:\\a')).toBe(1); // nothing left to flush
  });
});

describe('coalescing key resolution and directory normalizers', () => {
  it('keys only the four documented event shapes', () => {
    expect(coalescingKey(frameEvent('session.status', { sessionID: 's1' }))).toBe('session.status:s1');
    expect(coalescingKey(frameEvent('lsp.updated', {}))).toBe('lsp.updated');
    expect(coalescingKey(frameEvent('message.part.delta', { messageID: 'm', partID: 'p', field: 'text' }))).toBe('message.part.delta:m:p:text');
    expect(coalescingKey(frameEvent('session.idle', { sessionID: 's1' }))).toBeNull();
  });

  it('resolves directory from envelope, properties, then info, else global', () => {
    expect(resolveEventDirectory(frameEvent('x', {}, 'D:\\work'))).toBe('D:\\work');
    expect(resolveEventDirectory(frameEvent('x', { directory: 'D:\\other' }))).toBe('D:\\other');
    expect(resolveEventDirectory(frameEvent('x', { info: { directory: 'D:\\info' } }))).toBe('D:\\info');
    expect(resolveEventDirectory(frameEvent('x', {}))).toBe('global');
  });
});

describe('bounded backoff', () => {
  it('caps at 5s when visible+online and 60s otherwise', () => {
    expect(computeRetryDelay(1, true, true, false)).toBe(250);
    expect(computeRetryDelay(5, true, true, false)).toBe(4000);
    expect(computeRetryDelay(20, true, true, false)).toBe(5000);
    expect(computeRetryDelay(20, false, true, false)).toBe(60_000);
    expect(computeRetryDelay(20, true, false, false)).toBe(60_000);
  });

  it('uses the long cap immediately for permanent 4xx paths', () => {
    expect(computeRetryDelay(1, true, true, true)).toBe(5000);
    expect(isPermanent4xx(403)).toBe(true);
    expect(isPermanent4xx(408)).toBe(false);
    expect(isPermanent4xx(429)).toBe(false);
    expect(isPermanent4xx(500)).toBe(false);
  });
});
