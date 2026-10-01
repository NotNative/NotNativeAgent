// SPDX-License-Identifier: Apache-2.0
// This worker coordinates updates and push notifications. API/application requests stay
// network-owned; a waiting update activates only after the user chooses Reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'NOTNATIVE_ACTIVATE_UPDATE') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotification(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApplication(event.notification.data?.sessionId));
});

function notificationText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit) : '';
}

async function showPushNotification(event) {
  let payload;
  try { payload = event.data?.json(); } catch { /* malformed pushes still produce a visible notification */ }
  const title = notificationText(payload?.title, 120) || 'NotNativeDesktop';
  const body = notificationText(payload?.body, 1_000) || 'There is new activity in your workspace.';
  const tag = notificationText(payload?.tag, 200);
  const sessionId = notificationSessionId(payload?.sessionId);
  await self.registration.showNotification(title, { body, ...(tag ? { tag } : {}), ...(sessionId ? { data: { sessionId } } : {}) });
}

function notificationSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

async function openApplication(value) {
  // Payloads cannot choose navigation destinations or carry authentication URLs.
  const destination = new URL('/', self.location.origin);
  const sessionId = notificationSessionId(value);
  if (sessionId) destination.searchParams.set('session', sessionId);
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    // Only reuse an exact destination. A notification never replaces another session's draft.
    let url;
    try { url = new URL(client.url); } catch { continue; }
    if (url.href !== destination.href) continue;
    try { await client.focus(); return; } catch { /* a closing window must not swallow the click */ }
  }
  await self.clients.openWindow(destination.href);
}
