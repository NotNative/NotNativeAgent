// SPDX-License-Identifier: Apache-2.0
/**
 * Scope separation (W-28, doc 04 §A.1–§A.2): the two data scopes — per-
 * directory child stores and global sidecar stores — are never merged. These
 * catalogs + validators make the boundary explicit and enforceable: a patch
 * applied to a directory child store must never carry global-sidecar keys
 * (the cross-directory session cache/status live ONLY in the sidecars), and
 * a sidecar patch must never carry directory-owned transcript/interaction
 * state (transcripts, diffs, permissions live ONLY in the child stores).
 */
import type { SyncState } from './types.ts';

/** Keys owned by the global sidecar stores; directory patches forbid them. */
export const GLOBAL_ONLY_KEYS = [
  'active',
  'archived',
  'statusById',
  'activeSessionIds',
  'hasLoaded',
  'loadSessions',
] as const;

/** Directory-store keys the sidecars must never receive. */
export const DIRECTORY_ONLY_KEYS = [
  'message',
  'part',
  'session_diff',
  'todo',
  'permission',
  'question',
  'activity',
  'sessionEventRevision',
  'sessionDeletedRevision',
  'sessionStatusReady',
] as const;

type UnknownRecord = Record<string, unknown>;

/** Keys from the forbidden catalog present in a patch object. */
function violations(patch: unknown, forbidden: readonly string[]): string[] {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [];
  return forbidden.filter((key) => key in (patch as UnknownRecord));
}

/** Throw when a directory child-store patch carries global-sidecar keys. */
export function assertDirectoryPatch(patch: unknown): void {
  const bad = violations(patch, GLOBAL_ONLY_KEYS);
  if (bad.length > 0) throw new Error(`directory store patch leaks global scope: ${bad.join(', ')}`);
}

/** Throw when a global sidecar patch carries directory-owned keys. */
export function assertGlobalPatch(patch: unknown): void {
  const bad = violations(patch, DIRECTORY_ONLY_KEYS);
  if (bad.length > 0) throw new Error(`global store patch leaks directory scope: ${bad.join(', ')}`);
}

/** Non-throwing probe for tests and audits. */
export function scopeViolations(patch: unknown, scope: 'directory' | 'global'): string[] {
  return violations(patch, scope === 'directory' ? GLOBAL_ONLY_KEYS : DIRECTORY_ONLY_KEYS);
}

/** Structural check: a directory state never gains sidecar-only fields. */
export function directoryStateLeaksGlobal(state: SyncState): string[] {
  return GLOBAL_ONLY_KEYS.filter((key) => key in (state as unknown as UnknownRecord));
}
