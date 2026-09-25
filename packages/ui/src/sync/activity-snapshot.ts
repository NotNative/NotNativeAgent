// SPDX-License-Identifier: Apache-2.0
/** Authenticated NNA Activity snapshots complement, never replace, live evidence. */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient } from '../lib/nnd/client.ts';
import { activityRecordFromEvent, MAX_ACTIVITY_RECORDS, type ActivityRecord } from './activity-log.ts';
import type { DirectoryStore } from './types.ts';

export function isNnaActivitySource(store: StoreApi<DirectoryStore>): boolean {
  const nnd: unknown = store.getState().config?.nnd;
  return !!nnd && typeof nnd === 'object' && !Array.isArray(nnd)
    && (nnd as Record<string, unknown>).engine === 'nna';
}

/** Returns false on any unavailable or malformed snapshot; existing evidence stays. */
export async function refreshActivitySnapshot(store: StoreApi<DirectoryStore>, directory: string, sessionID: string,
  isCurrent: () => boolean = () => true): Promise<boolean> {
  let response;
  try { response = await harnessClient.listActivity(sessionID, { directory }); }
  catch { return false; }
  if (!isCurrent() || response.error || !Array.isArray(response.data) || response.data.length > MAX_ACTIVITY_RECORDS) return false;
  const snapshot: ActivityRecord[] = [];
  for (const item of response.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = activityRecordFromEvent({ type: 'nnd.activity', properties: item as Record<string, unknown> });
    if (!record || record.sessionID !== sessionID) return false;
    snapshot.push(record);
  }
  if (!isCurrent()) return false;
  store.setState((state) => {
    const merged = mergeActivitySnapshot(state.activity, sessionID, snapshot);
    return merged === state.activity ? state : { activity: merged };
  });
  return true;
}

/** Snapshot order is source order; live rows absent from it stay at the tail. */
export function mergeActivitySnapshot(current: readonly ActivityRecord[], sessionID: string,
  snapshot: readonly ActivityRecord[]): ActivityRecord[] {
  const currentRows = current.filter((item) => item.sessionID === sessionID);
  const byId = new Map(currentRows.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const merged: ActivityRecord[] = [];
  for (const item of snapshot) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const live = byId.get(item.id);
    merged.push(live && preferLive(live, item) ? live : item);
  }
  for (const live of currentRows) if (!seen.has(live.id)) merged.push(live);
  const next = [...current.filter((item) => item.sessionID !== sessionID), ...merged].slice(-MAX_ACTIVITY_RECORDS);
  return sameRows(current, next) ? current as ActivityRecord[] : next;
}

function preferLive(live: ActivityRecord, saved: ActivityRecord): boolean {
  if (live.time !== saved.time) return live.time > saved.time;
  const rank = (status: ActivityRecord['status']): number => status === 'redacted' ? 4
    : status === 'attention' || status === 'failed' ? 3 : status === 'started' ? 1 : 2;
  return rank(live.status) >= rank(saved.status);
}

function sameRows(left: readonly ActivityRecord[], right: readonly ActivityRecord[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return !!other && item.id === other.id && item.sessionID === other.sessionID && item.time === other.time
      && item.kind === other.kind && item.status === other.status && item.summary === other.summary
      && item.evidenceMessageID === other.evidenceMessageID;
  });
}
