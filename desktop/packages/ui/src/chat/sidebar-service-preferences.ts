// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { toast } from 'sonner';
const PINS = 'nnd.sessions.pinned.v1';
let epoch = 0, enabled = false, ready = false;
let revisions = new Map<string, number>();
let pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let writes: Promise<void> = Promise.resolve();
export function resetSidebarServicePreferences(): void { epoch += 1; enabled = false; ready = false; revisions = new Map(); pending = new Map(); if (timer) clearTimeout(timer); timer = null; }
export function queueSidebarPreference(key: string, value: string): void {
  if (!enabled) return; pending.set(key, value); if (!ready) return;
  if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void flushSidebarPreferences(); }, 120);
}
async function flushSidebarPreferences(): Promise<void> {
  const generation = epoch, runtime = getRuntimeKey();
  const entries = [...pending]; pending.clear();
  writes = writes.catch(() => undefined).then(async () => {
    for (const [key, value] of entries) {
      if (generation !== epoch || runtime !== getRuntimeKey()) return;
      const response = await runtimeFetch('/api/workspace-preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ key, value, expected_revision: revisions.get(key) ?? 0 }) });
      const row = await response.json(); if (!response.ok) throw new Error(row.error || 'Could not save sidebar preferences.');
      if (generation !== epoch || runtime !== getRuntimeKey()) return;
      revisions.set(key, row.revision);
    }
  });
  await writes.catch(error => { if (generation === epoch) toast.error(String(error)); });
}
export async function connectSidebarServicePreferences(): Promise<void> {
  resetSidebarServicePreferences(); enabled = true; const generation = epoch, runtime = getRuntimeKey();
  try {
    const response = await runtimeFetch('/api/workspace-preferences', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Could not restore sidebar preferences.');
    const rows = await response.json() as Record<string, { revision: number; value: string }>;
    if (generation !== epoch || runtime !== getRuntimeKey()) return;
    for (const [key, row] of Object.entries(rows)) {
      revisions.set(key, row.revision); if (pending.has(key)) continue;
      if (key.startsWith('sidebar.')) localStorage.setItem(`nnd.sidebar.v1:${runtime}:${key.slice(8)}`, row.value);
      else if (key === 'pins') {
        const saved = JSON.parse(row.value) as Record<string, number>, pins: Record<string, number> = {};
        for (const [encoded, time] of Object.entries(saved)) {
          const pair = JSON.parse(encoded) as string[];
          if (pair.length === 2 && pair.every(value => typeof value === 'string') && Number.isFinite(time)) pins[JSON.stringify([runtime, ...pair])] = time;
        }
        localStorage.setItem(PINS, JSON.stringify(pins));
      }
    }
    ready = true; window.dispatchEvent(new Event('nnd:sidebar-preferences-restored')); await flushSidebarPreferences();
  } catch (error) { if (generation === epoch) toast.error(String(error)); }
}
if (typeof window !== 'undefined') window.addEventListener('notnative:runtime-endpoint-changed', resetSidebarServicePreferences);
