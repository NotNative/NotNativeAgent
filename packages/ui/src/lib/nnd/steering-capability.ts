// SPDX-License-Identifier: Apache-2.0
/** Steering capability snapshot: a display hint only, refreshed by the
 * component poll and at reconnect time. NNA stays the final arbiter — the
 * pre-submit recheck and the steer POST never consult this cache. NNA
 * derives the grant live per request and bumps its revision only on child
 * completion, so the revision field is opaque here and never a freshness
 * token. Snapshots are keyed by directory+session so a sessionID collision
 * across roots cannot seed another root's button. */
import { harnessClient, normalizeDirectory } from './client.ts';

export interface SteeringCapabilitySnapshot {
  allowed: boolean;
  fetchedAt: number;
}

const snapshots = new Map<string, SteeringCapabilitySnapshot>();
const inflight = new Map<string, Promise<SteeringCapabilitySnapshot | undefined>>();
const listeners = new Set<(key: string) => void>();

export function steeringKey(sessionID: string, directory: string): string {
  return `${normalizeDirectory(directory)}\u0000${sessionID}`;
}

export function steeringAllowed(sessionID: string, directory: string): boolean {
  return snapshots.get(steeringKey(sessionID, directory))?.allowed === true;
}

export function steeringSnapshot(sessionID: string, directory: string): SteeringCapabilitySnapshot | undefined {
  return snapshots.get(steeringKey(sessionID, directory));
}

export function subscribeSteering(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Best-effort refresh: a failed read leaves the previous snapshot (the next
 * poll retries) and never throws to the caller. */
export async function refreshSteeringCapability(sessionID: string, directory: string,
): Promise<SteeringCapabilitySnapshot | undefined> {
  const key = steeringKey(sessionID, directory);
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      const result = await harnessClient.childSteeringCapability(sessionID, { directory });
      if (result.error || result.data?.session_id !== sessionID) return steeringSnapshot(sessionID, directory);
      const allowed = result.data.capabilities?.steer_subagent === true
        && result.data.availability === 'granted';
      const snapshot = { allowed, fetchedAt: Date.now() };
      snapshots.set(key, snapshot);
      for (const listener of listeners) listener(key);
      return snapshot;
    } catch {
      return steeringSnapshot(sessionID, directory);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

export function __resetSteeringSnapshotsForTests(): void {
  snapshots.clear();
  inflight.clear();
  listeners.clear();
}
