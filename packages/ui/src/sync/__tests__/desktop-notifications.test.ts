// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { createDesktopNotificationEventHandler } from '../desktop-notifications.ts';

describe('desktop notification event production', () => {
  it('respects settings and the hidden-only delivery mode', () => {
    const notify = vi.fn().mockResolvedValue(true);
    const settings = { nativeNotificationsEnabled: true, notifyOnCompletion: true, notificationMode: 'hidden-only' as const };
    const deliver = createDesktopNotificationEventHandler({ settings: () => settings, notify, now: () => 100 });
    deliver({ type: 'session.idle', directory: 'C:/work', properties: { sessionID: 's-1' } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'completion', sessionId: 's-1', directory: 'C:/work', requireHidden: true,
    }));
    settings.nativeNotificationsEnabled = false;
    deliver({ type: 'session.error', directory: 'C:/work', properties: { sessionID: 's-2' } });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('notifies questions and completed subtasks once per stable event id', () => {
    const notify = vi.fn().mockResolvedValue(true);
    const settings = () => ({ nativeNotificationsEnabled: true, notifyOnQuestion: true, notifyOnSubtasks: true });
    let timestamp = 100;
    const deliver = createDesktopNotificationEventHandler({ settings, notify, now: () => timestamp });
    const question = { type: 'question.asked', properties: { id: 'q-1', sessionID: 's-1', questions: [{ question: 'Which option?' }] } };
    const subtask = { type: 'nnd.activity', properties: { id: 'a-1', sessionID: 's-1', kind: 'subagent', status: 'completed', summary: 'Research done' } };
    deliver(question); deliver(question); deliver(subtask); deliver(subtask);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'question', body: 'Which option?' }));
    expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'subtask', body: 'Research done' }));
    timestamp += 10_000;
    deliver(question); // stable authored ids remain suppressed after reconnect delays
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('expires anonymous settle fingerprints so a later turn can notify', () => {
    const notify = vi.fn().mockResolvedValue(true);
    let timestamp = 100;
    const deliver = createDesktopNotificationEventHandler({
      settings: () => ({ nativeNotificationsEnabled: true, notifyOnCompletion: true }),
      notify, now: () => timestamp,
    });
    const idle = { type: 'session.idle', properties: { sessionID: 's-1' } };
    deliver(idle); deliver(idle);
    timestamp += 5_000;
    deliver(idle);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not deliver settle events for sessions rejected by authoritative context', () => {
    const notify = vi.fn().mockResolvedValue(true);
    const deliver = createDesktopNotificationEventHandler({
      settings: () => ({ nativeNotificationsEnabled: true, notifyOnCompletion: true }),
      notify,
      shouldNotify: (_event, _kind, sessionId) => sessionId === 'top-level',
    });
    deliver({ type: 'session.idle', directory: 'C:/work', properties: { sessionID: 'child' } });
    deliver({ type: 'session.idle', directory: 'C:/work', properties: { sessionID: 'top-level' } });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'top-level' }));
  });

  it('preserves the authoritative routed directory when the event omits it', () => {
    const notify = vi.fn().mockResolvedValue(true);
    const shouldNotify = vi.fn(() => true);
    const deliver = createDesktopNotificationEventHandler({
      settings: () => ({ nativeNotificationsEnabled: true, notifyOnQuestion: true }),
      notify,
      resolveDirectory: () => 'D:/actual-work',
      shouldNotify,
    });
    deliver({ type: 'question.asked', properties: { id: 'q-1', sessionID: 's-1' } });
    expect(shouldNotify).toHaveBeenCalledWith(expect.objectContaining({ directory: 'D:/actual-work' }), 'question', 's-1');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ directory: 'D:/actual-work' }));
  });
});
