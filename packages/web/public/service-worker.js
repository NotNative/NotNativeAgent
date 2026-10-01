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
  event.waitUntil(openApplication());
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
  await self.registration.showNotification(title, { body, ...(tag ? { tag } : {}) });
}

async function openApplication() {
  // Payloads cannot choose navigation destinations or carry authentication URLs.
  const home = new URL('/', self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    const url = new URL(client.url);
    if (url.origin !== self.location.origin || url.pathname !== '/' || url.search || url.hash) continue;
    try { await client.focus(); return; } catch { /* a closing window must not swallow the click */ }
  }
  await self.clients.openWindow(home);
}
