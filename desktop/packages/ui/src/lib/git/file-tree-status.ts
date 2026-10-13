// SPDX-License-Identifier: Apache-2.0
/**
 * File-tree git status index (doc 06 §2.2): one derivation per git snapshot.
 * A path carries exactly one of git-added (index A or untracked ?),
 * git-deleted (index D), git-modified (index/working M) — else null; the
 * `open` tab status is a row-level overlay applied separately so tab changes
 * never rebuild the git index. Directory badges aggregate descendants as
 * M{count} / +{count} keyed by repo-relative directory ('' = root).
 */
import type { GitStatusFile } from './api';

export type TreeGitStatus = 'git-added' | 'git-deleted' | 'git-modified';

export interface FolderBadge {
  modified: number;
  added: number;
}

export interface FileTreeStatusIndex {
  statusByPath: Map<string, TreeGitStatus | null>;
  badgeByDir: Map<string, FolderBadge>;
}

/** slash-normalized ancestors of a repo-relative path; '' = root. */
export function treeAncestorDirsOf(path: string): string[] {
  const normalized = path.replaceAll('\\', '/');
  const ancestors = [''];
  for (let index = normalized.indexOf('/'); index !== -1; index = normalized.indexOf('/', index + 1)) {
    ancestors.push(normalized.slice(0, index));
  }
  return ancestors;
}

export function buildFileTreeStatusIndex(files: readonly GitStatusFile[]): FileTreeStatusIndex {
  const statusByPath = new Map<string, TreeGitStatus | null>();
  const badgeByDir = new Map<string, FolderBadge>();
  for (const file of files) {
    const status = fileIndexTreeStatus(file);
    if (!statusByPath.has(file.path)) statusByPath.set(file.path, status);
    if (status === null) continue;
    const modified = status === 'git-modified' ? 1 : 0;
    const added = status === 'git-added' ? 1 : 0;
    for (const ancestor of treeAncestorDirsOf(file.path)) {
      const badge = badgeByDir.get(ancestor) ?? { modified: 0, added: 0 };
      badge.modified += modified;
      badge.added += added;
      badgeByDir.set(ancestor, badge);
    }
  }
  return { statusByPath, badgeByDir };
}

/** §2.2 precedence: added (A / untracked) beats deleted beats modified. */
function fileIndexTreeStatus(file: GitStatusFile): TreeGitStatus | null {
  const index = file.index.trim();
  const working = file.working_dir.trim();
  if (isUntrackedStatusFile(file) || index === 'A') return 'git-added';
  if (index === 'D') return 'git-deleted';
  if (index === 'M' || working === 'M') return 'git-modified';
  return null;
}

export function isUntrackedStatusFile(file: GitStatusFile): boolean {
  return file.index.trim() === '?' || file.working_dir.trim() === '?';
}

/** CSS var name per status (doc 06 §2.2 palette). */
export function treeStatusColor(status: TreeGitStatus): string {
  if (status === 'git-added') return 'var(--status-success)';
  if (status === 'git-deleted') return 'var(--status-error)';
  return 'var(--status-warning)';
}
