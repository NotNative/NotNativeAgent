// SPDX-License-Identifier: Apache-2.0
/** Device-local open/closed choice, scoped to a stable runtime and workspace. */
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';

export function panelOpenStorageKey(directoryKey: string): string | null {
  const runtime = getRuntimeKey();
  return isTransientRuntimeKey(runtime) ? null : `nnd.operator-rail.open:${runtime}:${directoryKey}`;
}

export function readPanelOpen(key: string | null, defaultOpen: boolean): boolean {
  if (key === null) return defaultOpen;
  try {
    const saved = localStorage.getItem(key);
    return saved === 'open' ? true : saved === 'closed' ? false : defaultOpen;
  } catch { return defaultOpen; }
}
