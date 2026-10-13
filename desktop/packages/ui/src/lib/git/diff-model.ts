// SPDX-License-Identifier: Apache-2.0
/**
 * Unified-diff model (doc 06 §5.1 + §A constants): parse a patch into
 * hunks (header info + add/del/context rows), extract a STANDALONE
 * git-apply-able patch per hunk, patch→model with the 64-entry LRU, the
 * binary-patch detectors, version-identity rule, and the last-changed-row
 * anchors for hunk-action overlays.
 */
export interface DiffRow {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
  /** LAST changed row anchor (§5.1 getPatchHunkAnchors). */
  anchor: { side: 'additions' | 'deletions'; lineNumber: number };
}

export interface FileDiffMetadata {
  path: string;
  hunks: DiffHunk[];
  insertionCount: number;
  deletionCount: number;
}

export const PATCH_DIFF_CACHE_LIMIT = 64;
export const FULL_CONTEXT_DIFF_LINES = 1_000_000;
export const LARGE_DIFF_CHANGED_LINES = 500;
export const DIFF_REQUEST_TIMEOUT_MS = 15_000;
export const STACKED_DIFF_MOUNT_MARGIN = 300;

export function isBinaryPatch(patch: string): boolean {
  return /^Binary files .* differ$/mu.test(patch) || /^GIT binary patch$/mu.test(patch);
}

const cache = new Map<string, FileDiffMetadata>();

function memoPath(file: string, contextLines: number, patch: string): string {
  return `${file}\0${contextLines}\0${patch}`;
}

/** §5.1: LRU of 64 keyed `file\0contextLines\0patch`. */
export function fileDiffFromPatch(file: string, patch: string, contextLines = 3): FileDiffMetadata {
  const key = memoPath(file, contextLines, patch);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached); // touch for LRU recency
    return cached;
  }
  const parsed = parsePatch(file, patch);
  cache.set(key, parsed);
  while (cache.size > PATCH_DIFF_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return parsed;
}

/** Split into git-apply-able standalone hunks: full file header + one hunk
 * each, LF-terminated (§5.1 splitPatchIntoHunks). */
export function splitPatchIntoHunks(patch: string): string[] {
  const lines = patch.split('\n');
  const header: string[] = [];
  const hunks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (current !== null) hunks.push([...header, ...current].join('\n') + '\n');
      current = [line];
      continue;
    }
    if (current === null) {
      if (/^(diff |index |--- |\+\+\+ )/u.test(line)) header.push(line);
      continue;
    }
    current.push(line);
  }
  if (current !== null) hunks.push([...header, ...current].join('\n') + '\n');
  return hunks;
}

export function extractHunkPatch(patch: string, index: number): string | null {
  return splitPatchIntoHunks(patch)[index] ?? null;
}

/**
 * §5.1 version identity: BOTH sides of `index <old>..<new>` must match as
 * full 40/64-hex blobs — abbreviated hashes or change-count thumbs are not
 * identity (partial staging changes the totals).
 */
export function haveMatchingPatchVersions(display: string, action: string): boolean {
  const full = /(^|\n)index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})/gu;
  const displayMatch = full.exec(display);
  full.lastIndex = 0;
  const actionMatch = full.exec(action);
  return displayMatch !== null && actionMatch !== null
    && displayMatch[2] === actionMatch[2]
    && displayMatch[3] === actionMatch[3];
}

function parsePatch(path: string, patch: string): FileDiffMetadata {
  const hunks: DiffHunk[] = [];
  let oldStart = 0;
  let newStart = 0;
  let rows: DiffRow[] = [];
  let hunkHeader = '';
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      if (rows.length > 0) hunks.push(finishHunk(hunkHeader, oldStart, newStart, rows));
      hunkHeader = line;
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      oldStart = match !== null ? Number(match[1]) : 1;
      newStart = match !== null ? Number(match[2]) : 1;
      rows = [];
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ )/u.test(line)) continue;
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) });
      insertions += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1) });
      deletions += 1;
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1) });
    } else if (/^\\ No newline/u.test(line)) {
      rows.push({ kind: 'context', text: '\\ no newline at end of file' });
    }
  }
  if (rows.length > 0) hunks.push(finishHunk(hunkHeader, oldStart, newStart, rows));
  return { path, hunks, insertionCount: insertions, deletionCount: deletions };
}

function finishHunk(header: string, oldStart: number, newStart: number, rows: DiffRow[]): DiffHunk {
  let oldLine = oldStart;
  let newLine = newStart;
  const anchor: { side: 'additions' | 'deletions'; lineNumber: number } = { side: 'deletions', lineNumber: oldStart };
  let found = false;
  for (const row of rows) {
    if (row.kind === 'add') {
      newLine += 1;
      if (!found || newLine - 1 >= anchor.lineNumber) {
        anchor.side = 'additions';
        anchor.lineNumber = newLine - 1;
      }
      found = true;
      continue;
    }
    if (row.kind === 'del') {
      oldLine += 1;
      if (oldLine - 1 >= anchor.lineNumber || !found) anchor.lineNumber = oldLine - 1;
      anchor.side = 'deletions';
      found = true;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }
  return { header: header || '', oldStart, newStart, rows, anchor };
}
