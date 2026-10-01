// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ value: { nativeNotificationsEnabled: true, notifyOnCompletion: true, notifyOnError: true, notifyOnQuestion: true } as Record<string, unknown> }));
vi.mock('../lib/settings-store.ts', () => ({ readMergedSettings: () => settings.value }));
import { attachPushNotifications, type createPushServices } from '../push/runtime.ts';
import { ManualQueueFeed } from '../queue/queue-feed.ts';
import { NotificationSessions } from '../notifications/session-state.ts';
import { PushBadges } from '../push/badge-state.ts';

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
  it('discards generation after question settlement, new turns, preference changes, and detach', async () => {
    for (const action of ['settled', 'new-turn', 'disabled', 'detach']) {
      settings.value = { nativeNotificationsEnabled: true, notifyOnCompletion: true, notifyOnQuestion: true };
      const feed = new ManualQueueFeed(); const deliver = vi.fn().mockResolvedValue({ sent: 1 });
      let release!: (value: unknown) => void;
      const render = vi.fn((payload) => new Promise((resolve) => { release = () => resolve({ ...payload, title: 'Generated' }); }));
      const sessions = new NotificationSessions(); const dispose = vi.fn();
      const services = { sessions, delivery: { deliver }, text: { render, dispose } } as unknown as ReturnType<typeof createPushServices>;
      const detach = attachPushNotifications(services, feed);
      const emit = (type: string, properties: Record<string, unknown>) => feed.emit({ payload: { id: 'event', type, properties } });
      emit(action === 'settled' ? 'question.asked' : 'session.idle', { sessionID: 'session', id: 'q1', questions: [{ question: 'Choose' }] });
      if (action === 'settled') emit('question.replied', { sessionID: 'session', requestID: 'q1' });
      if (action === 'new-turn') emit('session.status', { sessionID: 'session', status: { type: 'busy' } });
      if (action === 'disabled') settings.value.nativeNotificationsEnabled = false;
      if (action === 'detach') detach();
      release({}); await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deliver).not.toHaveBeenCalled(); detach();
    }
  });
  it('retains the event badge revision across delayed generation so viewing cannot revive a count', async () => {
    settings.value = { nativeNotificationsEnabled: true, notifyOnCompletion: true };
    const feed = new ManualQueueFeed(); const badges = new PushBadges(); const initial = badges.checkpoint();
    let release!: () => void;
    const render = (payload: unknown) => new Promise((resolve) => { release = () => resolve(payload); });
    const deliver = vi.fn().mockResolvedValue({ sent: 1 });
    const services = { badges, text: { render, dispose() {} }, delivery: { deliver } } as unknown as ReturnType<typeof createPushServices>;
    const detach = attachPushNotifications(services, feed);
    feed.emit({ payload: { id: 'idle', type: 'session.idle', properties: { sessionID: 'session' } } });
    badges.clear('owner', 'session'); release(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliver.mock.calls[0]![2]).toBe(initial);
    expect(badges.markQueued('owner', 'session', deliver.mock.calls[0]![2])).toBeNull(); detach();
  });
  it('keeps a delayed subtask for its parent completion but drops it after another turn starts or completes', async () => {
    for (const outcome of ['parent-idle', 'next-busy', 'next-idle']) {
      settings.value = { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
      const feed = new ManualQueueFeed(); const sessions = new NotificationSessions();
      const deliver = vi.fn().mockResolvedValue({ sent: 1 }); const published = vi.fn();
      sessions.subscribe(published);
      let release!: () => void;
      const render = (payload: unknown) => new Promise((resolve) => { release = () => resolve(payload); });
      const services = { sessions, text: { render, dispose() {} }, delivery: { deliver } } as unknown as ReturnType<typeof createPushServices>;
      const detach = attachPushNotifications(services, feed);
      const emit = (type: string, properties: Record<string, unknown>) => feed.emit({ payload: { id: 'event', type, properties } });
      const status = (type: string) => emit('session.status', { sessionID: 'session', status: { type } });
      status('busy');
      emit('nnd.activity', { sessionID: 'session', id: 'subtask-1', kind: 'subagent', status: 'completed', summary: 'Research done' });
      status('idle');
      if (outcome !== 'parent-idle') status('busy');
      if (outcome === 'next-idle') status('idle');
      release(); await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deliver).toHaveBeenCalledTimes(outcome === 'parent-idle' ? 1 : 0);
      expect(published.mock.calls.filter(([event]) => event.type === 'notnative:notification')).toHaveLength(outcome === 'parent-idle' ? 1 : 0);
      detach();
    }
  });
  it('does not start model-backed subtask work before its parent projection is available', async () => {
    settings.value = { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
    const feed = new ManualQueueFeed(); const sessions = new NotificationSessions();
    const deliver = vi.fn().mockResolvedValue({ sent: 1 }); const render = vi.fn(async (payload) => payload);
    const services = { sessions, text: { render, dispose() {} }, delivery: { deliver } } as unknown as ReturnType<typeof createPushServices>;
    const detach = attachPushNotifications(services, feed);
    const emit = (type: string, properties: Record<string, unknown>) => feed.emit({ payload: { id: 'event', type, properties } });
    emit('nnd.activity', { sessionID: 'unknown-parent', id: 'subtask-unknown', kind: 'subagent', status: 'completed' });
    emit('session.deleted', { sessionID: 'unknown-parent' });
    expect(render).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    emit('session.status', { sessionID: 'known-parent', status: { type: 'busy' } });
    emit('nnd.activity', { sessionID: 'known-parent', id: 'subtask-known', kind: 'subagent', status: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
    detach();
  });
});
