// SPDX-License-Identifier: Apache-2.0
/** Deterministic working-tree walkthrough. No model calls or inferred intent. */
import { fetchGitDiff, fetchGitStatus, isStagedStatusFile, isWorkingStatusFile } from './api.ts';
import { fileDiffFromPatch, isBinaryPatch, type DiffHunk } from './diff-model.ts';

export interface WalkthroughStopPreview {
  id: string;
  scope: 'staged' | 'working';
  path: string;
  header: string;
  oldStart: number;
  newStart: number;
  patch: string;
  hunk: DiffHunk;
}
export interface WalkthroughPreview { signature: string; stops: WalkthroughStopPreview[]; fileCount: number; binaryFiles: number }
export const WALKTHROUGH_MAX_FILES = 60;
export const WALKTHROUGH_MAX_HUNKS = 200;
export const WALKTHROUGH_MAX_PATCH_CHARS = 750_000;

export async function loadWalkthroughPreview(directory: string): Promise<WalkthroughPreview> {
  const status = await fetchGitStatus(directory, 'full');
  if (!status?.isGitRepository) throw new Error('No Git repository is available.');
  const entries = status.files.flatMap((file) => [
    ...(isStagedStatusFile(file) ? [{ path: file.path, scope: 'staged' as const }] : []),
    ...(isWorkingStatusFile(file) ? [{ path: file.path, scope: 'working' as const }] : []),
  ]);
  if (entries.length > WALKTHROUGH_MAX_FILES) throw new Error(`Walkthrough preview supports at most ${WALKTHROUGH_MAX_FILES} changed file scopes.`);
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope));
  const stops: WalkthroughStopPreview[] = [];
  const signatures: string[] = [];
  let binaryFiles = 0;
  let patchChars = 0;
  for (const entry of entries) {
    const response = await fetchGitDiff(directory, entry.path, { staged: entry.scope === 'staged', contextLines: 3 });
    if (response === null || typeof response.diff !== 'string') throw new Error(`Could not load the current diff for ${entry.path}.`);
    const patch = response.diff;
    patchChars += patch.length;
    if (patchChars > WALKTHROUGH_MAX_PATCH_CHARS) throw new Error('Diff is too large for the bounded walkthrough preview.');
    signatures.push(`${entry.scope}\0${entry.path}\0${patch}`);
    if (isBinaryPatch(patch)) { binaryFiles += 1; continue; }
    const hunks = fileDiffFromPatch(entry.path, patch).hunks;
    for (const [index, hunk] of hunks.entries()) {
      if (stops.length >= WALKTHROUGH_MAX_HUNKS) throw new Error(`Walkthrough preview supports at most ${WALKTHROUGH_MAX_HUNKS} hunks.`);
      stops.push({
        id: `${entry.scope}:${entry.path}:${hunk.oldStart}:${hunk.newStart}:${index}`,
        scope: entry.scope, path: entry.path, header: hunk.header,
        oldStart: hunk.oldStart, newStart: hunk.newStart, patch, hunk,
      });
    }
  }
  // The complete bounded patch payload is the revision proof. A changed body
  // with the same file list/line counts must still invalidate the preview.
  const statusSignature = JSON.stringify({ branch: status.branch, files: status.files.map((file) =>
    [file.path, file.index, file.working_dir, file.staged]) });
  return { signature: `${statusSignature}\0${signatures.join('\0\0')}`, stops, fileCount: entries.length, binaryFiles };
}
