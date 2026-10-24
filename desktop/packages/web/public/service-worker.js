// SPDX-License-Identifier: Apache-2.0
// This worker coordinates updates and push notifications. API/application requests stay
// network-owned; a waiting update activates only after the user chooses Reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'NOTNATIVE_ACTIVATE_UPDATE') {
    // Security: only a same-origin window may request activation of this update.
    try {
      if (event.source?.type === 'window' && new URL(event.source.url).origin === self.location.origin) {
        event.waitUntil(self.skipWaiting());
      }
    } catch { /* ignore messages without a valid local window source */ }
  }
  if (event.data?.type === 'NOTNATIVE_BADGE_STATE') {
    try {
      if (new URL(event.source?.url).origin === self.location.origin) event.waitUntil(updateAppBadge(event.data.badge, event.data.runtimeOrigin));
    } catch { /* only a controlled same-origin window can report a reset */ }
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
  await updateAppBadge(payload?.badge);
}

let badgeTail = Promise.resolve();
let badgeState;
const badgeCacheName = 'notnative-badge-state-v1';

function validBadge(value) {
  return value && typeof value === 'object' && Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 9999
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.epoch === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.epoch);
}

function updateAppBadge(value, runtimeOrigin) {
  if (!validBadge(value)) return Promise.resolve();
  const next = badgeTail.then(() => applyBadgeState(value, validRuntimeOrigin(runtimeOrigin)));
  badgeTail = next.catch(() => undefined);
  return badgeTail;
}

function validRuntimeOrigin(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 2048 && ['http:', 'https:'].includes(url.protocol) && url.origin === value ? value : undefined;
  } catch { return undefined; }
}

async function applyBadgeState(value, runtimeOrigin) {
  const key = new URL('/_notnative_badge_state', self.location.origin).href;
  let cache;
  try {
    cache = await self.caches?.open(badgeCacheName);
    if (!badgeState) {
      const saved = await (await cache?.match(key))?.json();
      if (validBadge(saved) && Array.isArray(saved.retired) && saved.retired.length <= 32
        && saved.retired.every((epoch) => validBadge({ count: 0, revision: 0, epoch }))) badgeState = saved;
    }
  } catch { /* badges still work in memory if optional storage is unavailable */ }
  const previous = badgeState;
  const origins = Array.isArray(previous?.origins) && previous.origins.length <= 32 ? previous.origins.filter((entry) => Array.isArray(entry) && entry.length === 2
    && validRuntimeOrigin(entry[0]) && validBadge({ epoch: entry[1], count: 0, revision: 0 })).slice(-32) : [];
  const returningInstance = runtimeOrigin && runtimeOrigin !== previous?.runtimeOrigin
    && origins.some(([origin, epoch]) => origin === runtimeOrigin && epoch === value.epoch);
  if (previous && (previous.epoch === value.epoch && previous.revision >= value.revision || previous.retired.includes(value.epoch) && !returningInstance)) return;
  const retired = previous ? [...previous.retired.filter((epoch) => epoch !== value.epoch), ...(previous.epoch === value.epoch ? [] : [previous.epoch])].slice(-32) : [];
  const origin = runtimeOrigin ?? validRuntimeOrigin(previous?.runtimeOrigin);
  const nextOrigins = origin ? [...origins.filter(([known]) => known !== origin), [origin, value.epoch]].slice(-32) : origins;
  badgeState = { count: value.count, epoch: value.epoch, revision: value.revision, retired,
    runtimeOrigin: origin, origins: nextOrigins };
  try { await cache?.put(key, new Response(JSON.stringify(badgeState))); } catch { /* optional persistent ordering */ }
  try {
    if (value.count === 0) await self.navigator?.clearAppBadge?.();
    else await self.navigator?.setAppBadge?.(value.count);
  } catch { /* unsupported badges and denied permission never hide the notification */ }
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
