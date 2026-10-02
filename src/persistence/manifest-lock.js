// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { manifestTarget, manifestFailure, regularOrMissing, writePrivateFile } from './manifest-files.js';

const LEASES = new WeakMap();
const COUNTS = new Map();
export function assertManifestLease(lease) {
  const state = LEASES.get(lease);
  if (!state?.held) throw manifestFailure('manifest_lock_invalid');
  return state.target;
}
export async function runManifestLeaseWork(lease, operation) {
  assertManifestLease(lease);
  const state=LEASES.get(lease);
  if (state.closing) throw manifestFailure('manifest_lock_invalid');
  if (state.pending.size >= 16) throw manifestFailure('manifest_lock_capacity');
  const pending=Promise.resolve().then(operation); state.pending.add(pending);
  try { return await pending; } finally { state.pending.delete(pending); }
}
export async function openManifestDatabase(path) {
  if (!await regularOrMissing(path)) {
    await writePrivateFile(path, Buffer.alloc(0)).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  }
  await regularOrMissing(path);
  for (const suffix of ['-journal','-wal','-shm']) await regularOrMissing(path + suffix);
  const database = new DatabaseSync(path);
  try { database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;'); return database; }
  catch (error) { database.close(); throw error; }
}
async function acquire(database, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try { database.exec('BEGIN IMMEDIATE'); return; }
    catch (error) {
      if (![5,6].includes(error.errcode)) throw manifestFailure('manifest_lock_unavailable');
      if (Date.now() >= deadline) throw manifestFailure('manifest_lock_busy');
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
}
export async function withManifestLock(path, options, operation) {
  const { signal, timeoutMs = 5000 } = options ?? {};
  if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw manifestFailure('manifest_lock_invalid');
  }
  const target = await manifestTarget(path, { signal });
  const count = COUNTS.get(target.key) ?? 0;
  if (count >= 16 || COUNTS.size >= 128 && count === 0) throw manifestFailure('manifest_lock_capacity');
  COUNTS.set(target.key, count + 1);
  let database, state;
  try {
    database = await openManifestDatabase(join(target.storage, 'lock.sqlite'));
    await acquire(database, signal, timeoutMs);
    state = { held: true, target, pending: new Set() };
    const lease = Object.freeze({}); LEASES.set(lease, state);
    // Security: cancellation does not prove the callback or its file writes have stopped.
    return await operation(lease);
  } finally {
    try { if (state) { state.closing = true; await Promise.allSettled([...state.pending]); state.held = false; database.exec('ROLLBACK'); } }
    finally {
      try { database?.close(); } finally {
        const remaining = COUNTS.get(target.key) - 1;
        if (remaining) COUNTS.set(target.key, remaining); else COUNTS.delete(target.key);
      }
    }
  }
}
