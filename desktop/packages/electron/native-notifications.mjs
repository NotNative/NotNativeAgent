// SPDX-License-Identifier: Apache-2.0
const DEDUPE_MS = 5_000;

function text(value, fallback = '', limit = 500) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : fallback;
}

export function createNativeNotifications({ Notification, getWindow, focusWindow, now = Date.now }) {
  const live = new Set();
  const recent = new Map();

  function openSessionWhenReady(win, detail) {
    const contents = win?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const send = () => {
      if (win.isDestroyed() || contents.isDestroyed()) return;
      contents.send('openchamber:emit', {
        event: 'openchamber:open-session', detail,
      });
    };
    if (!contents.isLoadingMainFrame()) {
      send();
      return;
    }

    // Clicking while ensureMainWindow() is creating/reloading the window can
    // otherwise send into the old/blank document and silently lose navigation.
    const cleanup = () => {
      contents.removeListener('did-finish-load', onLoaded);
      contents.removeListener('destroyed', cleanup);
    };
    const onLoaded = () => { cleanup(); send(); };
    contents.once('did-finish-load', onLoaded);
    contents.once('destroyed', cleanup);
  }

  function notify(raw) {
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!Notification?.isSupported?.()) return { shown: false, reason: 'unsupported' };
    const win = getWindow();
    if ((payload?.requireHidden === true || payload?.require_hidden === true)
      && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
      return { shown: false, reason: 'window-visible' };
    const title = text(payload?.title, 'NotNativeDesktop', 200);
    const body = text(payload?.body, '', 2_000);
    const tag = text(payload?.tag, '', 200);
    const sessionId = text(payload?.sessionId ?? payload?.session_id, '', 500);
    const directory = text(payload?.directory, '', 2_000);
    const kind = text(payload?.kind, '', 100);
    const key = tag ? `tag:${tag}` : `message:${sessionId}\0${kind}\0${title}\0${body}`;
    const timestamp = now();
    for (const [candidate, time] of recent) if (timestamp - time >= DEDUPE_MS) recent.delete(candidate);
    if (recent.has(key)) return { shown: false, reason: 'duplicate' };
    if (typeof Notification !== 'function') return { shown: false, reason: 'unsupported' };
    recent.set(key, timestamp);
    let notification;
    try {
      notification = new Notification({ title, body, silent: false });
      live.add(notification);
      const release = () => live.delete(notification);
      notification.once('close', release);
      notification.once('failed', release);
      notification.once('click', () => {
        release();
        focusWindow?.();
        if (sessionId) {
          const target = getWindow();
          openSessionWhenReady(target, { sessionId, ...(directory ? { directory } : {}) });
        }
      });
      notification.show();
      return { shown: true };
    } catch {
      if (notification) live.delete(notification);
      recent.delete(key);
      return { shown: false, reason: 'delivery-failed' };
    }
  }

  return { notify, dispose() { for (const notification of live) { try { notification.close(); } catch {} } live.clear(); recent.clear(); } };
}
