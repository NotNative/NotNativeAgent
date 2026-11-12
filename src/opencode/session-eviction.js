// SPDX-License-Identifier: Apache-2.0
// Idle eviction for OpenCode wire sessions.
//
// Why: an idle conversation should not hold its engine — three durable file
// handles (journal, lock, ledger) per conversation is a real resource cost at
// dozens of conversations. This module shuts idle engines down while keeping
// the durable index and the registry's dormant record, and re-attaches on
// demand through the ordinary boot-restore path, so an evicted conversation's
// first turn pays one journal replay and nothing else changes for the client.
import { closeSession } from './session-lifecycle.js';
import { readSessionIndex } from './session-index.js';
import { join } from 'node:path';

const DEFAULT_IDLE_MS = 30 * 60_000;
const MIN_IDLE_MS = 60_000;
const MAX_IDLE_MS = 24 * 3_600_000;
const EVICTION_SWEEP_MS = 60_000;

/** Configure eviction on a workspace. Why defaults are conservative: eviction
 *  is a resource optimization, not a correctness feature — no conversation is
 *  ever lost, but a surprise re-attach delay is worse than holding handles a
 *  while longer. Pass `idleMs: 0` to disable. */
export function configureEviction(workspace, options = {}) {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  if (idleMs !== 0 && (!Number.isSafeInteger(idleMs) || idleMs < MIN_IDLE_MS || idleMs > MAX_IDLE_MS)) {
    throw new RangeError('idle eviction threshold must be 0 or 60_000..86_400_000 ms');
  }
  const state = { idleMs, sweepMs: Math.min(EVICTION_SWEEP_MS, idleMs || EVICTION_SWEEP_MS), timer: null, evicted: [] };
  workspace.eviction = state;
  if (idleMs === 0) return state;
  state.timer = setInterval(() => {
    try { evictIdleSessions(workspace); }
    catch { /* a sweep failure must never take the surface down */ }
  }, state.sweepMs);
  state.timer.unref?.();
  return state;
}

export function stopEviction(workspace) {
  const state = workspace?.eviction;
  if (state?.timer) clearInterval(state.timer);
  if (state) state.timer = null;
}

/** Shut every session idle past the threshold. Why busy sessions are skipped:
 *  `closeSession` aborts pending work, and eviction must never cancel live
 *  work — the idle clock is `registry.touch`, which every wire-visible change
 *  updates, so an active conversation never reaches the threshold anyway. */
export async function evictIdleSessions(workspace) {
  const state = workspace.eviction;
  if (!state || state.idleMs === 0) return [];
  const now = Date.now();
  const evicted = [];
  for (const record of workspace.registry.list()) {
    if (record.evicted) continue;
    if (now - record.updatedAt < state.idleMs) continue;
    // Why close-then-relist: `closeSession` removes the registry entry as part
    // of its contract; eviction re-attaches the identity as a dormant record so
    // the client's list still shows the conversation and a prompt re-attaches.
    await closeSession(workspace, record.ocId);
    workspace.registry.attach({
      ocId: record.ocId, title: record.title, directory: record.directory,
      createdAt: record.createdAt, updatedAt: record.updatedAt, parentID: record.parentID,
      projectID: record.projectID, slug: record.slug, evicted: true,
      engine: null, ingress: null, wireSession: null,
    });
    state.evicted.push({ ocId: record.ocId, at: now });
    evicted.push(record.ocId);
  }
  return evicted;
}

/** Re-attach one evicted conversation by replaying its journal.
 *
 *  Why through `operations.restore`: that is the boot-restore path — the
 *  engine replays its own journal when constructed with the recorded session
 *  id, and the history seeding is the same supervised construction a fresh
 *  session gets. The durable index still holds the identity; nothing is
 *  minted. */
export async function reattachEvictedSession(workspace, options, ocId) {
  if (!workspace.registry.isEvicted(ocId)) return null;
  const index = await readSessionIndex(options.storeRoot);
  const entry = index.find((record) => record.ocId === ocId);
  if (!entry) throw new Error(`evicted session ${ocId} has no durable identity`);
  // Why the dormant record is dropped first: re-attach attaches a live record
  // under the same ocId, and the registry refuses duplicates — the dormant
  // entry is only a placeholder, its truth is the durable index.
  workspace.registry.remove(ocId);
  // Why operations is the bundle-level handle: `defineWorkspaceOperations`
  // closes over the inner workspace, so re-attach uses the same supervised
  // attach path a boot restore uses.
  const operations = options.operations ?? workspace.operations;
  const described = await operations.restore({
    ocId: entry.ocId, engineSessionId: entry.sessionId, title: entry.title ?? 'Restored session',
    directory: entry.directory ?? '', createdAt: entry.createdAt ?? null, parentID: entry.parentID ?? null,
    ...(Number.isFinite(entry.archivedAt) ? { archivedAt: entry.archivedAt } : {}),
  });
  return described;
}
