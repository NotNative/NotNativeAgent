// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-process config lock (doc 12 §C.5): an exclusive-create (`wx`) lock
 * file `{pid, at}` beside the per-project config. Two processes cannot both
 * hold it; a lock older than 60 s is stale and may be stolen; acquisition
 * waits at most 10 s on a 20 ms cadence. A lock file that exists but cannot
 * be read yet is mid-write for a fresh process, so it is only stolen once it
 * has been unparseable for 5 s. Release verifies the document still names
 * THIS pid before unlinking, then closes this caller's descriptor (the
 * unlink alone does not close it), so lock fds are never leaked.
 * A lock failure throws; callers treat that as `claim-failed`, not a crash.
 */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_LOCK_RETRY_MS, CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAIT_MS } from './scheduled-constants.ts';

export interface LockDocument { pid: number; at: number }

/** Pure, so tests can pin the lock document path (storage rule). */
export function lockPathFor(configPath: string): string {
  return `${configPath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function readLock(path: string): LockDocument | null {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockDocument>;
    return typeof doc?.pid === 'number' && typeof doc?.at === 'number'
      ? { pid: doc.pid, at: doc.at } : null;
  } catch {
    return null;
  }
}

function isStaleUnreadable(path: string, now: number): boolean {
  try {
    return Number.isFinite(now - statSync(path).mtimeMs) && now - statSync(path).mtimeMs > 5_000;
  } catch {
    return false; // vanished between checks; the next openSync decides
  }
}

function steal(path: string): void {
  try { unlinkSync(path); } catch { /* another process beat us to it */ }
}

export interface ConfigLock { release(): void }

/** Acquires the config lock or throws after the wait budget. */
export async function acquireConfigLock(configPath: string): Promise<ConfigLock> {
  const lockPath = lockPathFor(configPath);
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* openSync surfaces it */ }
  for (;;) {
    let owned: number | null = null;
    try {
      owned = openSync(lockPath, 'wx');
      writeFileSync(owned, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockDocument));
      const fd = owned;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const doc = readLock(lockPath);
          if (doc !== null && doc.pid === process.pid) {
            try { unlinkSync(lockPath); } catch { /* already gone */ }
          }
          try { closeSync(fd); } catch { /* already closed */ }
        },
      };
    } catch (error) {
      if (owned !== null) { try { closeSync(owned); } catch { /* already closed */ } }
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) throw new Error('config lock wait expired');
    const held = readLock(lockPath);
    if (held !== null) {
      if (Date.now() - held.at > CONFIG_LOCK_STALE_MS) steal(lockPath);
    } else if (isStaleUnreadable(lockPath, Date.now())) {
      steal(lockPath);
    }
    await sleep(CONFIG_LOCK_RETRY_MS);
  }
}

/** In-process chain so two async writers on one path serialize BEFORE they
 * reach the cross-process lock (never wedges: the chain continues through
 * rejections). */
const chains = new Map<string, Promise<unknown>>();

export function chained<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const outcome = previous.then(run, run);
  // The bookkeeping tail must fulfill even when the caller's operation
  // rejects; otherwise an expected write failure becomes an unhandled
  // rejection while the caller is already handling `outcome`.
  const tail = outcome.then(() => undefined, () => undefined).then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);
  return outcome;
}

/** Runs `fn` under both the in-process chain and the cross-process lock. */
export async function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  return chained(configPath, async () => {
    const lock = await acquireConfigLock(configPath);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  });
}
