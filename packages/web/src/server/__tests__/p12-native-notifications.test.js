// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createNativeNotifications } from '../../../../electron/native-notifications.mjs';

function fixture({ loading = false, now } = {}) {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.isLoadingMainFrame = () => loading;
  contents.sent = [];
  contents.send = (...args) => contents.sent.push(args);
  const win = { webContents: contents, isDestroyed: () => false, isVisible: () => false, isMinimized: () => false };
  const notifications = [];
  class NativeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  const focusWindow = vi.fn();
  const controller = createNativeNotifications({ Notification: NativeNotification, getWindow: () => win, focusWindow, ...(now ? { now } : {}) });
  return { controller, notifications, win, contents, focusWindow };
}

describe('native desktop notifications', () => {
  it('deduplicates for five seconds, honors hidden gating, and releases on close', () => {
    let time = 10;
    const f = fixture({ now: () => time });
    f.win.isVisible = () => true;
    expect(f.controller.notify({ requireHidden: true }).reason).toBe('window-visible');
    f.win.isVisible = () => false;
    expect(f.controller.notify({ title: 'Ready', tag: 'session-1' }).shown).toBe(true);
    expect(f.controller.notify({ title: 'Updated', tag: 'session-1' }).reason).toBe('duplicate');
    time += 5_001;
    expect(f.controller.notify({ title: 'Ready', tag: 'session-1' }).shown).toBe(true);
  });

  it('waits for a loading window before routing a clicked notification to its session', () => {
    const f = fixture({ loading: true });
    expect(f.controller.notify({ sessionId: 's-1', directory: 'C:/work' }).shown).toBe(true);
    f.notifications[0].emit('click');
    expect(f.focusWindow).toHaveBeenCalledOnce();
    expect(f.contents.sent).toHaveLength(0);
    f.contents.emit('did-finish-load');
    expect(f.contents.sent[0]).toEqual(['openchamber:emit', {
      event: 'openchamber:open-session', detail: { sessionId: 's-1', directory: 'C:/work' },
    }]);
  });
});
