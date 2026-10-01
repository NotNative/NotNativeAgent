// SPDX-License-Identifier: Apache-2.0
import { tryGetRuntimeAPIs } from './api/registry.ts';
import { getApiBaseUrlActive, getRuntimeKey } from './runtime-switch.ts';
import type { PushApi } from './api/push-types.ts';

let working = false;

export function browserPushAvailable(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext || window.__NOTNATIVE_ELECTRON__?.runtime === 'electron') return false;
  if (typeof Notification === 'undefined' || typeof PushManager === 'undefined' || !('serviceWorker' in navigator)) return false;
  try { return new URL(getApiBaseUrlActive() ?? window.location.origin).origin === window.location.origin && !!tryGetRuntimeAPIs()?.push; }
  catch { return false; }
}

function context(): { api: PushApi; current: () => void } {
  if (!browserPushAvailable()) throw new Error('Browser push is unavailable for this connection');
  const runtime = getRuntimeKey();
  const endpoint = getApiBaseUrlActive();
  return { api: tryGetRuntimeAPIs()!.push!, current: () => {
    if (runtime !== getRuntimeKey() || endpoint !== getApiBaseUrlActive() || !browserPushAvailable()) throw new Error('Push connection changed');
  } };
}

export async function browserPushSubscribed(): Promise<boolean> {
  const captured = context();
  const registration = await navigator.serviceWorker.getRegistration('/');
  captured.current();
  const subscription = await registration?.pushManager.getSubscription();
  captured.current();
  return !!subscription;
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const registration = await Promise.race([
      (async () => {
        await navigator.serviceWorker.register('/service-worker.js');
        return navigator.serviceWorker.ready;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Push worker did not become ready')), 15_000); }),
    ]);
    const worker = registration.active;
    if (!worker || new URL(worker.scriptURL).href !== new URL('/service-worker.js', window.location.origin).href
      || registration.scope !== new URL('/', window.location.origin).href) throw new Error('Unexpected push worker');
    return registration;
  } finally { if (timer) clearTimeout(timer); }
}

export async function enableBrowserPush(): Promise<void> {
  const captured = context();
  if (working) throw new Error('Push change is already running');
  working = true;
  try {
    // Request synchronously from the user's click, before worker/network awaits.
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    captured.current();
    if (permission !== 'granted') throw new Error('Notification permission was not granted');
    const registration = await activeRegistration();
    captured.current();
    const { publicKey } = await captured.api.getVapidPublicKey();
    captured.current();
    const bytes = Uint8Array.from(atob(publicKey.replace(/-/gu, '+').replace(/_/gu, '/')), (char) => char.charCodeAt(0));
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    captured.current();
    const data = subscription.toJSON();
    if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw new Error('Browser subscription is incomplete');
    await captured.api.subscribe({ endpoint: data.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth }, platform: 'web' });
    captured.current();
  } finally { working = false; }
}

export async function disableBrowserPush(): Promise<void> {
  const captured = context();
  if (working) throw new Error('Push change is already running');
  working = true;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    captured.current();
    const subscription = await registration?.pushManager.getSubscription();
    captured.current();
    if (!subscription) return;
    await captured.api.unsubscribe({ endpoint: subscription.endpoint });
    captured.current();
    if (!await subscription.unsubscribe()) throw new Error('Browser did not confirm unsubscribe');
  } finally { working = false; }
}
