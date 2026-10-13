// SPDX-License-Identifier: Apache-2.0
/** Shared scratch space for NND smoke/acceptance fixtures (operator cleanup
 *  policy 2026-10-11): one deletable root per machine, shared with the NNA
 *  suite scratch (`~/.nna-test-scratch`), so no fixture directory spills
 *  loose into the user profile. The profile ancestor chain is preserved on
 *  purpose: NNA rejects shared Temp ancestors with other-user Modify rights,
 *  so fixtures must stay under the signed-in user's profile. Each reserve
 *  call arms a best-effort synchronous exit cleanup. */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCRATCH_ROOT = join(homedir(), '.nna-test-scratch');
const tracked = new Set();
let exitHandlerInstalled = false;

function track(root) {
  tracked.add(root);
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => {
    for (const root of tracked) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort: leftovers stay inside the scratch root */ }
    }
  });
}

/** Reserve a unique, NOT-yet-created fixture path under the scratch root
 *  (the caller creates the directory itself, often with a private ACL). */
export function reserveScratch(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(prefix)) {
    throw new TypeError('reserveScratch requires a bounded prefix');
  }
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = join(SCRATCH_ROOT, `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  track(root);
  return root;
}

/** Create a unique fixture directory under the scratch root immediately. */
export function createScratchSync(prefix) {
  const root = reserveScratch(prefix);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Explicit early cleanup; the exit handler then treats it as a no-op. */
export function disposeScratch(root) {
  if (typeof root !== 'string' || !root.startsWith(SCRATCH_ROOT + '\\') && !root.startsWith(SCRATCH_ROOT + '/')) {
    throw new TypeError('disposeScratch only accepts paths inside the scratch root');
  }
  tracked.delete(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
