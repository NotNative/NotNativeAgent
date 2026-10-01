// SPDX-License-Identifier: Apache-2.0
import type { PushBadge } from './api/push-types.ts';
import { getApiBaseUrlActive } from './runtime-switch.ts';
const fallbackStates = new WeakMap<Navigator, { badge: PushBadge; tail: Promise<void> }>();
let latestRequest = 0;
let latestConfirmed = 0;

/** A delayed response from a retired server epoch cannot override a newer request. */
export function beginBrowserBadgeRequest(): (badge: PushBadge, target: Navigator) => void {
  const request = ++latestRequest;
  const origin = runtimeOrigin();
  return (badge, target) => {
    if (request > latestConfirmed) { latestConfirmed = request; applyBrowserBadge(badge, target, origin); }
  };
}

function runtimeOrigin(): string | undefined {
  try { return new URL(getApiBaseUrlActive() ?? window.location.origin).origin; } catch { return undefined; }
}

export function pushBadge(value: unknown): PushBadge | null {
  if (!value || typeof value !== 'object') return null;
  const badge = value as PushBadge;
  return Number.isSafeInteger(badge.count) && badge.count >= 0 && badge.count <= 9999
    && Number.isSafeInteger(badge.revision) && badge.revision >= 0
    && typeof badge.epoch === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(badge.epoch) ? badge : null;
}

export function applyBrowserBadge(badge: PushBadge, navigator: Navigator, origin = runtimeOrigin()): void {
  const target = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    const worker = navigator.serviceWorker?.controller;
    if (worker) { worker.postMessage({ type: 'NOTNATIVE_BADGE_STATE', badge, runtimeOrigin: origin }); return; }
    const previous = fallbackStates.get(navigator);
    if (previous?.badge.epoch === badge.epoch && previous.badge.revision >= badge.revision) return;
    const tail = (previous?.tail ?? Promise.resolve()).then(async () => {
      try { await (badge.count === 0 ? target.clearAppBadge?.() : target.setAppBadge?.(badge.count)); }
      catch { /* optional badge failures leave subsequent updates usable */ }
    });
    fallbackStates.set(navigator, { badge, tail });
  } catch { /* optional browser badges never block work */ }
}
