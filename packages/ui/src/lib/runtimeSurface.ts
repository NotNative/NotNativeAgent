// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted-surface decision + runtime classification helpers (doc 01 §3.5, §6.3).
 * Mobile branch is recognized but its app tree is long-term deferred (doc 11);
 * mobile-surface renders fall back to the desktop tree with a console notice.
 */
import { getSurfaceStamp } from './runtimeConfig.ts';

export type HostedSurface = 'desktop' | 'mobile';

export function resolveHostedSurface(): HostedSurface {
  const stamp = getSurfaceStamp();
  if (stamp) return stamp;
  if (typeof window === 'undefined') return 'desktop';
  const forced = new URLSearchParams(window.location.search).get('surface');
  if (forced === 'mobile' || forced === 'desktop') return forced;
  if (isMobileViewportHeuristic()) return 'mobile';
  return 'desktop';
}

export function stampHostedSurface(surface: HostedSurface): void {
  if (typeof window === 'undefined') return;
  if (window.__NOTNATIVE_SURFACE__) return; // stamped once (§16.8)
  window.__NOTNATIVE_SURFACE__ = surface;
}

/** `?surface=` override present ⇒ the viewport drift watcher must not reload. */
export function isSurfaceForced(): boolean {
  if (typeof window === 'undefined') return false;
  const forced = new URLSearchParams(window.location.search).get('surface');
  return forced === 'mobile' || forced === 'desktop';
}

export function isMobileViewportHeuristic(): boolean {
  if (typeof window === 'undefined') return false;
  const narrow = Math.min(window.innerWidth, window.screen?.width ?? window.innerWidth) <= 768;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches === true;
  return narrow && coarse;
}

/** §10.1 step: 800 ms debounced full reload when surface class drifts post-boot. */
export function watchHostedSurfaceViewport(initial: HostedSurface): void {
  if (typeof window === 'undefined' || isSurfaceForced()) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const nowMobile = isMobileViewportHeuristic();
      const wasMobile = initial === 'mobile';
      if (nowMobile !== wasMobile) window.location.reload();
    }, 800);
  });
}
