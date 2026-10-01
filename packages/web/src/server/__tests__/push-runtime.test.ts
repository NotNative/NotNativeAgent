// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ value: { nativeNotificationsEnabled: true, notifyOnCompletion: true, notifyOnError: true, notifyOnQuestion: true } as Record<string, unknown> }));
vi.mock('../lib/settings-store.ts', () => ({ readMergedSettings: () => settings.value }));
import { attachPushNotifications, type createPushServices } from '../push/runtime.ts';
import { ManualQueueFeed } from '../queue/queue-feed.ts';

describe('server-owned push event subscription', () => {
  it('gates and deduplicates event delivery, then detaches without stopping the shared feed', async () => {
    settings.value = { nativeNotificationsEnabled: true, notifyOnCompletion: true, notifyOnError: true, notifyOnQuestion: true };
    const feed = new ManualQueueFeed(); const deliver = vi.fn().mockResolvedValue({ sent: 1 });
    const services = { delivery: { deliver } } as unknown as ReturnType<typeof createPushServices>;
    const detach = attachPushNotifications(services, feed); const other = vi.fn(); feed.onEvent(other);
    const emit = (type: string, properties: Record<string, unknown> = { sessionID: 'session' }) => feed.emit({ directory: '/work', payload: { id: 'event', type, properties } });
    emit('message.updated'); expect(deliver).not.toHaveBeenCalled();
    emit('session.idle'); emit('session.idle');
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'completion', sessionId: 'session', title: 'Agent finished' }), expect.any(Function));
    emit('question.asked', { sessionID: 'session', id: 'question-1', questions: [{ question: 'Please choose' }] });
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'question', body: 'Please choose' }), expect.any(Function));
    const eligible = deliver.mock.calls.at(-1)![1] as () => boolean;
    expect(eligible()).toBe(true);
    settings.value.notifyOnQuestion = false; expect(eligible()).toBe(false);
    settings.value.notifyOnQuestion = true;
    settings.value.nativeNotificationsEnabled = false; emit('session.error'); expect(eligible()).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(2);
    detach(); settings.value.nativeNotificationsEnabled = true; emit('session.error');
    expect(deliver).toHaveBeenCalledTimes(2); expect(other).toHaveBeenCalledTimes(6);
  });
});
