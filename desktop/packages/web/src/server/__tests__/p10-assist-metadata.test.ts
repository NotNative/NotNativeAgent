// SPDX-License-Identifier: Apache-2.0
/** P10-57 H.2 contract pins: metadata validation, merge preservation, live arming. */
import { describe, expect, it, vi } from 'vitest';
import { mergeAssistIntoMetadata, parseSessionAssist } from '../session-assist/assist-metadata.ts';
import { SessionAssistRuntime } from '../session-assist/session-assist-runtime.ts';
import { ASSIST_RECAP_CHAR_LIMIT, ASSIST_SUGGESTION_CHAR_LIMIT } from '../session-assist/assist-metadata.ts';

const RENDERABLE = {
  recap: 'Recap', suggestion: 'Try again', forMessageID: 'assistant-9', generatedAt: 9,
};

describe('session-assist metadata contract', () => {
  it('requires freshness identity and one useful field', () => {
    expect(parseSessionAssist({ openchamber: { assist: {
      ...RENDERABLE, forMessageID: 'assistant-9' } } })).toEqual(RENDERABLE);
    expect(parseSessionAssist({ openchamber: { assist: RENDERABLE } })).toEqual(RENDERABLE);
    expect(parseSessionAssist({ openchamber: { assist: {
      ...RENDERABLE, forMessageID: 'assistant-9' } } })).toEqual(RENDERABLE);
    expect(parseSessionAssist({ openchamber: { assist: { ...RENDERABLE, generatedAt: 0 } } })).toBeNull();
    expect(parseSessionAssist({ openchamber: { assist: { ...RENDERABLE, forMessageID: '' } } })).toBeNull();
    expect(parseSessionAssist({ openchamber: { assist: { ...RENDERABLE, recap: ' ', suggestion: '' } } })).toBeNull();
    expect(parseSessionAssist({ openchamber: { assist: [] } })).toBeNull();
    expect(parseSessionAssist({ openchamber: { assist: unknownRecord() } })).toBeNull();
  });

  it('rejects malformed fields and clamps oversized generated values', () => {
    expect(ASSIST_RECAP_CHAR_LIMIT).toBe(320);
    expect(ASSIST_SUGGESTION_CHAR_LIMIT).toBe(500);
    const valid = parseSessionAssist({ openchamber: { assist: {
      recap: 'a'.repeat(ASSIST_RECAP_CHAR_LIMIT + 1),
      suggestion: 'b'.repeat(ASSIST_SUGGESTION_CHAR_LIMIT + 5),
      forMessageID: 'assistant-9', generatedAt: 3 } } });
    expect(valid?.recap).toHaveLength(ASSIST_RECAP_CHAR_LIMIT);
    expect(valid?.suggestion).toHaveLength(ASSIST_SUGGESTION_CHAR_LIMIT);
    expect(parseSessionAssist({ openchamber: { assist: { ...RENDERABLE, generatedAt: Number.MAX_SAFE_INTEGER + 1 } } })).toBeNull();
  });

  it('merge-writes unrelated namespaces and adjacent openchamber keys', () => {
    const before = { unrelated: true, openchamber: { existing: 'kept', other: 7 } };
    const after = mergeAssistIntoMetadata(before, RENDERABLE);
    expect(after).toEqual({ unrelated: true, openchamber: {
      existing: 'kept', other: 7, assist: RENDERABLE } });
    expect(before).toEqual({ unrelated: true, openchamber: { existing: 'kept', other: 7 } });
  });
});

function unknownRecord(): Record<string, unknown> {
  return Object.create(null);
}

interface Envelope { payload: { type?: unknown; properties?: Record<string, unknown> }; directory?: string }

function feed(listeners: Array<(value: unknown) => void>) {
  return { onEvent(on: (value: unknown) => void) { listeners.push(on); return () => {}; } } as never;
}

function envelope(type: string, properties: Record<string, unknown>, directory = '/project'): Envelope {
  return { payload: { type, properties }, directory };
}

const SESSION = { id: 'session-1', directory: '/project', info: {} };
const MESSAGES = [{ info: { id: 'assistant-1', role: 'assistant', time: { completed: 3 } },
  parts: [{ type: 'text', text: 'finished' }] }];

describe('live assist trigger lifecycle', () => {
  it('arms on live idle and invalidates on newer user activity', async () => {
    vi.useFakeTimers();
    const listeners: Array<(value: unknown) => void> = [];
    const generate = vi.fn();
    const runtime = new SessionAssistRuntime(feed(listeners), {
      readSession: vi.fn(async () => SESSION),
      readMessages: vi.fn(async () => MESSAGES),
      writeMetadata: vi.fn(async () => true),
      generate,
    }, () => true, { quietMs: 5 });
    runtime.start();
    const emit = listeners[0]!;
    emit(envelope('message.updated', {
      sessionID: 'session-1',
      info: { role: 'user', time: { created: Date.now() + 5 } },
    }));
    await vi.advanceTimersByTimeAsync(50);
    expect(generate).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('passes the completed assistant tail to the isolated port and records fresh metadata', async () => {
    vi.useFakeTimers();
    const listeners: Array<(value: unknown) => void> = [];
    const merged = [{}];
    const runtime = new SessionAssistRuntime(feed(listeners), {
      readSession: vi.fn(async () => SESSION),
      readMessages: vi.fn(async () => MESSAGES),
      writeMetadata: vi.fn(async (_id, _directory, metadata) => { merged[0] = metadata; return true; }),
      generate: vi.fn(async () => ({ recap: ' Recap ', suggestion: ' suggestion ' })),
    }, () => true, { quietMs: 5 });
    runtime.start();
    const emit = listeners[0]!;
    emit(envelope('message.updated', {
      sessionID: 'session-1',
      info: { role: 'user', time: { created: Date.now() + 5 } },
    }));
    const tick = await runtime.tick('session-1');
    expect(tick).toEqual({ kind: 'written' });
    const metadata = merged[0] as { openchamber?: { assist?: Record<string, unknown> } };
    expect(metadata.openchamber?.assist).toMatchObject({
      recap: 'Recap', suggestion: 'suggestion', forMessageID: 'assistant-1',
    });
    runtime.dispose();
  });

  it('does not duplicate the payload path when validation and merge are unchanged', async () => {
    vi.useFakeTimers();
    const listeners: Array<(value: unknown) => void> = [];
    const readMessages = vi.fn(async () => MESSAGES);
    const merged = [{}];
    const runtime = new SessionAssistRuntime(feed(listeners), {
      readSession: vi.fn(async () => SESSION),
      readMessages,
      writeMetadata: vi.fn(async (_id, _directory, metadata) => {
        merged[0] = metadata;
        return true;
      }),
      generate: vi.fn(async () => ({
        recap: ' Recap ',
        suggestion: ' suggestion ',
      })),
    }, () => true, { quietMs: 5 });
    runtime.start();
    listeners[0]!(envelope('message.updated', {
      sessionID: 'session-1',
      info: { role: 'user', time: { created: Date.now() + 5 } },
    }));
    expect(await runtime.tick('session-1')).toEqual({ kind: 'written' });
    expect(readMessages).toHaveBeenCalledTimes(2);
    expect(merged[0]).toEqual({ openchamber: { assist: expect.any(Object) } });
    runtime.dispose();
  });

});
