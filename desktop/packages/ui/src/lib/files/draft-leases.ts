// SPDX-License-Identifier: Apache-2.0
/** In-memory, per-runtime file drafts retained while the Files editor unmounts. */
import { readFileStat, readFileText } from './api.ts';
import { looksLikeBinaryText, prepareFileEditorContent } from './edit-support.ts';

export interface DraftStat { size: number; mtimeMs: number | null }
export interface DraftLease {
  draft: string;
  baseline: string;
  lineEnding: '\n' | '\r\n';
  stat: DraftStat | null;
  autoSaveEnabled: boolean;
}

const leases = new Map<string, DraftLease>();
const keyOf = (runtime: string, root: string, path: string): string => JSON.stringify([runtime, root, path]);

export function readDraftLease(runtime: string, root: string, path: string): DraftLease | null {
  const value = leases.get(keyOf(runtime, root, path));
  return value ? { ...value, stat: value.stat ? { ...value.stat } : null } : null;
}

export function rememberDraftLease(runtime: string, root: string, path: string, lease: DraftLease): void {
  const key = keyOf(runtime, root, path);
  if (lease.draft === lease.baseline) { leases.delete(key); return; }
  leases.set(key, { ...lease, stat: lease.stat ? { ...lease.stat } : null });
}

export function forgetDraftLease(runtime: string, root: string, path: string, onlyIfDraft?: string): void {
  const key = keyOf(runtime, root, path);
  if (onlyIfDraft === undefined || leases.get(key)?.draft === onlyIfDraft) leases.delete(key);
}

export function sameDraftStat(a: DraftStat | null, b: DraftStat | null): boolean {
  return a !== null && b !== null && a.mtimeMs !== null && b.mtimeMs !== null
    && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Stat plus a fresh baseline read prevents recovery from trusting a reused
 * timestamp or a same-size external edit before allowing a normal save. */
export async function inspectDraftLeaseOnDisk(root: string, path: string, lease: DraftLease): Promise<'verified' | 'changed' | 'unknown'> {
  try {
    const current = await readFileStat(root, path);
    if (current === null) return 'unknown';
    if (!current.isFile || current.exists === false) return 'changed';
    if (!sameDraftStat(lease.stat, { size: current.size, mtimeMs: current.mtimeMs ?? null })) return 'changed';
    const content = await readFileText(root, path, true);
    if (looksLikeBinaryText(content)) return 'changed';
    const prepared = prepareFileEditorContent(content);
    return prepared.draft === lease.baseline && prepared.lineEnding === lease.lineEnding ? 'verified' : 'changed';
  } catch { return 'unknown'; }
}

export function __resetDraftLeasesForTests(): void { leases.clear(); }
