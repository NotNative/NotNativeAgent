// SPDX-License-Identifier: Apache-2.0
/** Width preferences leave the session list and a readable chat column visible. */
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';

export function surfaceWidthStorageKey(directoryKey: string, surface: string): string | null {
  const runtime = getRuntimeKey();
  return isTransientRuntimeKey(runtime) ? null : `nnd.operator-rail.width:${runtime}:${directoryKey}:${surface}`;
}

export function maxRailWidth(viewportWidth: number): number {
  // The dock is beside a 288px session sidebar, not an otherwise empty page.
  // A width saved on an ultrawide monitor must leave a readable chat column
  // when restored in the ordinary desktop window.
  const sidebarWidth = 288;
  const dockWidth = 41;
  const minimumChatWidth = 480;
  return Math.max(280, Math.min(1200, viewportWidth - sidebarWidth - dockWidth - minimumChatWidth));
}

export function clampRailWidth(width: number, viewportWidth: number): number {
  return Math.min(maxRailWidth(viewportWidth), Math.max(280, Math.round(width)));
}

export function readWidth(key: string | null, surface: string): number {
  const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const fallback = viewport >= 1600 ? Math.min(1200, Math.round(viewport * 0.36)) : surface === 'browser' ? 600 : 300;
  if (key === null) return fallback;
  try {
    const raw = localStorage.getItem(key);
    const saved = raw === null ? NaN : Number(raw);
    return Number.isFinite(saved) ? Math.min(1200, Math.max(280, Math.round(saved))) : fallback;
  } catch { return fallback; }
}
