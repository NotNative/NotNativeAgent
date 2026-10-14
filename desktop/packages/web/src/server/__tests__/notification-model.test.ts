// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationModelText } from '../notifications/model-text.ts';
import { notificationAssistantText } from '../notifications/model-context.ts';
import type { NotificationPayload } from '../../../../ui/src/sync/desktop-notifications.ts';
import type { generateSmallModel } from '../routes/small-model.ts';

const payload: NotificationPayload = { title: 'Agent finished', body: 'The session completed its turn.', kind: 'completion',
  sessionId: 'session-1', directory: '/workspace', tag: 'completion:session-1', requireHidden: true };
const response = (value: unknown) => Response.json({ text: JSON.stringify(value) });
const generator = (value: unknown) => vi.fn(async () => response(value)) as unknown as typeof generateSmallModel;
afterEach(() => vi.useRealTimers());

describe('bounded model notification text', () => {
  it('uses the actual configured small-model service and preserves all server-owned identity', async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Build verified', body: 'All checks passed.' }) } }] }));
    const messages = vi.fn(async () => [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'private user input' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'The build checks passed.' }, { type: 'reasoning', text: 'private reasoning' }, { type: 'tool', state: { input: 'secret args' } }] },
    ]);
    const text = new NotificationModelText({ messages, ports: {
      providers: async () => [{ id: 'openai', options: { apiKey: 'test-key' }, models: { 'gpt-nano': { id: 'gpt-nano', api: { url: 'https://provider.example/v1' }, limit: { context: 20000, output: 1024 } } } }],
      config: async () => ({}), settings: async () => ({}), fetch: fetcher, // uniformity #2: small_model is dead - family fallback selects gpt-nano
    } });
    expect(await text.render(payload, () => true)).toEqual({ ...payload, title: 'Build verified', body: 'All checks passed.' });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://provider.example/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-nano'); expect(body.max_completion_tokens).toBe(256);
    expect(body.messages[1].content).toContain('The build checks passed.');
    expect(body.messages[1].content).not.toMatch(/private user|private reasoning|secret args|test-key/u);
    expect(body.response_format.json_schema.schema.required).toEqual(['title', 'body']);
    text.dispose();
  });
  it.each([null, [], {}, { title: 'Title', body: '' }, { title: 'T'.repeat(121), body: 'Text' },
    { title: 'Title', body: 'Text\nControl' }, { title: 'Title', body: 'Text', sessionId: 'other' }])('falls back on malformed or authority-changing text %j', async (value) => {
    const text = new NotificationModelText({ messages: async () => [], generate: generator(value) });
    expect(await text.render(payload, () => true)).toEqual(payload); text.dispose();
  });
  it('falls back on unavailable providers, generation failures, and truncated input', async () => {
    for (const generate of [async () => Response.json({}, { status: 404 }), async () => { throw new Error('offline'); },
      async () => Response.json({ text: '{bad' }), async () => Response.json({ text: JSON.stringify({ title: 'Title', body: 'Text' }), inputTruncated: true })]) {
      const text = new NotificationModelText({ messages: async () => [], generate: generate as typeof generateSmallModel });
      expect(await text.render(payload, () => true)).toEqual(payload); text.dispose();
    }
  });
  it('limits hangs to two slots and delivers fallbacks while ignoring later work after timeout', async () => {
    vi.useFakeTimers(); const releases: ((value: unknown[]) => void)[] = [];
    const messages = vi.fn(() => new Promise<unknown[]>((resolve) => releases.push(resolve)));
    const generate = generator({ title: 'Title', body: 'Text' });
    const text = new NotificationModelText({ messages, generate, timeoutMs: 20 });
    const first = text.render(payload, () => true); const second = text.render(payload, () => true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toEqual(payload); expect(await second).toEqual(payload);
    expect(await text.render(payload, () => true)).toEqual(payload); expect(messages).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release([])); await vi.advanceTimersByTimeAsync(0);
    expect(generate).not.toHaveBeenCalled();
    messages.mockResolvedValueOnce([]);
    expect(await text.render(payload, () => true)).toEqual({ ...payload, title: 'Title', body: 'Text' });
    text.dispose();
  });
  it('disposal and disabled preferences abort waits and cannot start later generation', async () => {
    const generate = generator({ title: 'Title', body: 'Text' });
    const text = new NotificationModelText({ messages: () => new Promise(() => {}), generate });
    const result = text.render(payload, () => true); text.dispose();
    expect(await result).toEqual(payload); expect(await text.render(payload, () => true)).toEqual(payload);
    expect(generate).not.toHaveBeenCalled();
    const disabled = new NotificationModelText({ generate });
    expect(await disabled.render(payload, () => false)).toEqual(payload); expect(generate).not.toHaveBeenCalled(); disabled.dispose();
  });
  it('bounds context and excludes untrusted tool/reasoning/user parts', () => {
    const text = notificationAssistantText(Array.from({ length: 100 }, () => ({ info: { role: 'assistant' }, parts: Array.from({ length: 100 }, () => ({ type: 'text', text: 'a'.repeat(10000) })) })));
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(notificationAssistantText([null, {}, { info: { role: 'user' }, parts: [{ type: 'text', text: 'secret' }] }])).toBe('');
  });
});
