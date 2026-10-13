// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createApp } from '../packages/web/src/server/app.ts';
import { createPushServices, attachPushNotifications } from '../packages/web/src/server/push/runtime.ts';
import { AdapterQueueFeed } from '../packages/web/src/server/queue/queue-feed.ts';
import { getUiAuthController } from '../packages/web/src/server/lib/auth/ui-auth.ts';
import { json, withTimeout } from './smoke-http.mjs';

export async function probeNotificationRoutes(parentId) {
  const services = createPushServices(); const app = createApp({ push: services }); const feed = new AdapterQueueFeed();
  const token = getUiAuthController().issueSessionToken(60_000).token;
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
    ...init, headers: { ...init.headers, cookie: `oc_ui_session=${token}` }, signal: AbortSignal.timeout(5000),
  }));
  const connected = new Promise((resolve) => { const stop = feed.onConnected(() => { stop(); resolve(); }); });
  const detach = attachPushNotifications(services, feed); feed.start();
  const abort = new AbortController(); let reader; let temporary;
  try {
    await withTimeout(connected, 5000, 'notification feed did not connect');
    const status = await json(call, '/api/sessions/status', 200);
    assert.equal(status.pendingCoverage, 'complete');
    assert.deepEqual(status.pending, {});
    assert.equal(status.sessions[parentId].status, 'idle');
    const snapshot = await json(call, '/api/sessions/snapshot', 200);
    assert.ok(snapshot.attentionSessions[parentId]);
    const response = await app.fetch(new Request('http://nnd.local/api/notifications/stream', {
      headers: { cookie: `oc_ui_session=${token}` }, signal: abort.signal,
    }));
    assert.equal(response.status, 200); reader = response.body.getReader();
    const next = notificationReader(reader);
    const ready = await next(); assert.equal(ready.type, 'notnative:notification-stream-ready');
    assert.notEqual(ready.properties.uiToken, token, 'stream must not disclose its authentication credential');
    temporary = await json(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Notification route smoke' }) }, 201);
    const event = await next(); assert.equal(event.type, 'notnative:session-status'); assert.equal(event.properties.sessionID, temporary.id);
    const viewed = await json(call, `/api/sessions/${temporary.id}/view`, { method: 'POST', body: JSON.stringify({ clientId: 'smoke', sequence: 1 }) }, 200);
    assert.equal(viewed.viewed, true); assert.equal(viewed.badge.count, 0);
    assert.equal((await json(call, `/api/sessions/${temporary.id}/attention`, 200)).isViewed, true);
    assert.equal((await json(call, `/api/sessions/${temporary.id}/message-sent`, { method: 'POST' }, 200)).messageSent, true);
    assert.equal((await json(call, `/api/sessions/${temporary.id}/unview`, { method: 'POST', body: JSON.stringify({ clientId: 'smoke', sequence: 2 }) }, 200)).viewed, false);
  } finally {
    abort.abort(); await reader?.cancel().catch(() => {}); detach(); feed.stop(); services.delivery.dispose();
    if (temporary) assert.equal(await json(call, `/api/session/${temporary.id}`, { method: 'DELETE' }, 200), true);
  }
}

function notificationReader(reader) {
  const decoder = new TextDecoder(); let buffer = '';
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: ')); if (data) return JSON.parse(data.slice(6));
      } else {
        const chunk = await withTimeout(reader.read(), 5000, 'notification SSE event timed out');
        if (chunk.done) throw new Error('notification stream ended'); buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
}
