// SPDX-License-Identifier: Apache-2.0
/** Single scratch space for suite temp directories (operator cleanup policy
 *  2026-10-11): every suite temp directory must land under one deletable
 *  root instead of spilling loose directories into the user profile. The
 *  root stays under the signed-in user's profile because installer/manifest
 *  suites rely on the profile's trusted-ancestor chain semantics. Each
 *  scratch directory is removed by a best-effort synchronous exit handler,
 *  so a suite cleans up after itself even when a test forgets its own
 *  `t.after` teardown; leftovers (for example, a locked file held by a
 *  detached child) remain inside the scratch root for the next sweep. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';

export const SCRATCH_ROOT = join(homedir(), '.nna-test-scratch');
const tracked = new Set();
const armedRestores = new Map();
let exitHandlerInstalled = false;
let aclExitHandlerInstalled = false;

function track(root) {
  tracked.add(root);
  installExitHandler();
}

function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => {
    for (const root of tracked) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort: leftovers stay inside the scratch root */ }
    }
  });
}

/** Create one suite scratch directory under the single scratch root and
 *  arm its self-cleanup. The returned path can be removed early with
 *  `disposeScratch` (a later exit-handler pass is then a no-op for it). */
export async function createScratch(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(prefix)) {
    throw new TypeError('createScratch requires a bounded prefix');
  }
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const root = await mkdtemp(join(SCRATCH_ROOT, `${prefix}-`));
  track(root);
  return root;
}

/** Synchronous variant for sync fixtures. */
export function createScratchSync(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(prefix)) {
    throw new TypeError('createScratch requires a bounded prefix');
  }
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
  track(root);
  return root;
}

/** Reserve a unique, NOT-yet-created path under the scratch root for
 *  fixtures that must create the directory themselves (for example a
 *  PowerShell `CreateDirectory` with a private ACL). */
export function reserveScratch(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(prefix)) {
    throw new TypeError('reserveScratch requires a bounded prefix');
  }
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = join(SCRATCH_ROOT, `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  track(root);
  return root;
}

/** Early explicit cleanup; also used by suites that own a `t.after`. */
export async function disposeScratch(root) {
  if (typeof root !== 'string' || !root.startsWith(SCRATCH_ROOT + sep)) {
    throw new TypeError('disposeScratch only accepts paths inside the scratch root');
  }
  tracked.delete(root);
  armedRestores.delete(root);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Assert one path is inside the scratch root before an ACL mutation runs.
 *
 *  Why a shared function instead of each suite's own string check: ACL
 *  mutation is the one test action whose residue can outlive the process, and
 *  a mis-resolved path once stranded a foreign ACE on the workspace root.
 *  Every mutating call asserts here, so the guarantee lives in one audited
 *  place instead of nine hand-rolled copies. */
export function assertScratchPath(path, label) {
  if (typeof path !== 'string' || !path.startsWith(SCRATCH_ROOT + sep)) {
    throw new TypeError(`${label ?? 'ACL mutation'} refused: ${String(path)} is outside the scratch root`);
  }
  return path;
}

function installAclExitRestore() {
  if (aclExitHandlerInstalled) return;
  aclExitHandlerInstalled = true;
  // Why a separate exit listener: the scratch-removal handler must run even
  // when a restore throws, so removal stays first and restores come second.
  process.once('exit', () => {
    for (const [path, applySddl] of armedRestores) {
      try { applySddl(); } catch { /* best effort: a failed restore must not mask the original failure */ }
    }
    armedRestores.clear();
  });
}

/** Arm a crash restore for one mutated scratch path.
 *
 *  Why: a suite can die between replacing a descriptor and restoring it — an
 *  unrelated flake aborts the runner mid-test — and a DACL left
 *  `NO_ACCESS_CONTROL` or generic-all outlives the scratch directory's own
 *  deletion only if the path was outside the root. Inside the root the exit
 *  removal already handles it; this arm covers the window where the mutated
 *  path is created but not yet removed, and makes the restore explicit so a
 *  later reader sees the armed state instead of trusting cleanup order. */
export function armScratchRestore(path, applySddl) {
  assertScratchPath(path, 'ACL restore');
  if (typeof applySddl !== 'function') throw new TypeError('armScratchRestore requires a restore function');
  installAclExitRestore();
  armedRestores.set(path, applySddl);
}

export function disarmScratchRestore(path) {
  assertScratchPath(path, 'ACL disarm');
  armedRestores.delete(path);
}
