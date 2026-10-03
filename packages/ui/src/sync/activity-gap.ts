// SPDX-License-Identifier: Apache-2.0
/** A stream gap is evidence that transient Activity history may be incomplete. */
import { getRuntimeKey, isTransientRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';

const PREFIX = 'nnd.activity-gap.v1:';
const listeners = new Set<() => void>();
const volatile = new Map<string, number>();

function storageKey(runtimeKey: string): string { return `${PREFIX}${encodeURIComponent(runtimeKey)}`; }

export function activityGapAt(runtimeKey = getRuntimeKey()): number | null {
  if (isTransientRuntimeKey(runtimeKey)) return volatile.get(runtimeKey) ?? null;
  const fallback = volatile.get(runtimeKey) ?? null;
  try {
    const value = window.localStorage.getItem(storageKey(runtimeKey));
    if (value === null) return fallback;
    const at = Number(value);
    const stored = /^\d{1,16}$/u.test(value) && Number.isSafeInteger(at) && at > 0 ? at : null;
    return stored === null ? fallback : Math.max(stored, fallback ?? 0);
  } catch { return fallback; }
}

export function markActivityGap(runtimeKey = getRuntimeKey(), at = Date.now()): void {
  if (!Number.isSafeInteger(at) || at <= 0) return;
  if (isTransientRuntimeKey(runtimeKey)) volatile.set(runtimeKey, at);
  else {
    try { window.localStorage.setItem(storageKey(runtimeKey), String(at)); volatile.delete(runtimeKey); }
    catch { volatile.set(runtimeKey, at); }
  }
  for (const listener of listeners) listener();
}

export function subscribeActivityGap(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

onRuntimeEndpointChanged(() => { for (const listener of listeners) listener(); });
