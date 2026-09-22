// SPDX-License-Identifier: Apache-2.0
/**
 * File-tree status index (doc 06 §2.2): per-path status precedence, badge
 * aggregation, untracked recovery, and the shared grouping semantics.
 */
import { describe, expect, it } from 'vitest';
import { buildFileTreeStatusIndex, treeStatusColor, treeAncestorDirsOf, type TreeGitStatus } from '../file-tree-status.ts';
import {
  isStagedStatusFile, isWorkingStatusFile, normalizeStatusFiles, statusSymbol, type GitStatus,
} from '../api';
import { groupedStatusFiles } from '../store';

describe('buildFileTreeStatusIndex (doc 06 §2.2)', () => {
  const dirty = (path: string, index: string, working: string): { path: string; index: string; working_dir: string } => ({ path, index, working_dir: working });

  it('derives exactly one status per path with the documented precedence', () => {
    const index = buildFileTreeStatusIndex([
      dirty('a.ts', 'M', ' '), // staged modified
      dirty('b.ts', ' ', 'M'), // worktree modified
      dirty('c.ts', '?', '?'), // untracked (recovered form)
      dirty('d.ts', 'D', ' '), // staged deletion
      dirty('e.ts', 'A', ' '), // staged addition
      dirty('package.json', ' ', ' '),
    ]);
    expect(index.statusByPath.get('a.ts')).toBe<TreeGitStatus | null>('git-modified');
    expect(index.statusByPath.get('b.ts')).toBe<TreeGitStatus | null>('git-modified');
    expect(index.statusByPath.get('c.ts')).toBe<TreeGitStatus | null>('git-added');
    expect(index.statusByPath.get('d.ts')).toBe<TreeGitStatus | null>('git-deleted');
    expect(index.statusByPath.get('e.ts')).toBe<TreeGitStatus | null>('git-added');
    expect(index.statusByPath.get('package.json')).toBeNull();
  });

  it('aggregates descendant badges on every ancestor, root included', () => {
    const index = buildFileTreeStatusIndex([
      dirty('src/deep/a.ts', '?', '?'),
      dirty('src/b.ts', ' ', 'M'),
      dirty('readme.md', 'M', ' '),
    ]);
    expect(index.badgeByDir.get('')).toEqual({ modified: 2, added: 1 });
    expect(index.badgeByDir.get('src')).toEqual({ modified: 1, added: 1 });
    expect(index.badgeByDir.get('src/deep')).toEqual({ modified: 0, added: 1 });
    expect(treeAncestorDirsOf('src\\deep\\a.ts')).toEqual(['', 'src', 'src/deep']); // windows separators normalize
  });

  it('maps branch colors per §2.2', () => {
    expect(treeStatusColor('git-added')).toBe('var(--status-success)');
    expect(treeStatusColor('git-deleted')).toBe('var(--status-error)');
    expect(treeStatusColor('git-modified')).toBe('var(--status-warning)');
  });
});

describe('git status derivations (doc 06 §6.3)', () => {
  const statusOf = (files: { path: string; index: string; working_dir: string; staged?: boolean }[]): GitStatus => ({
    isGitRepository: true,
    branch: 'main',
    trackingAhead: 0,
    trackingBehind: 0,
    files: files.map((file) => ({ path: file.path, index: file.index, working_dir: file.working_dir, staged: file.staged })),
  });

  it('recovers the untracked double-? the route erased', () => {
    expect(normalizeStatusFiles([
      { path: 'new.ts', index: ' ', working_dir: ' ', staged: false },
      { path: 'edit.ts', index: ' ', working_dir: 'M' },
      { path: 'staged.ts', index: 'M', working_dir: ' ', staged: true },
    ])).toEqual([
      { path: 'new.ts', index: '?', working_dir: '?', staged: false },
      { path: 'edit.ts', index: ' ', working_dir: 'M' },
      { path: 'staged.ts', index: 'M', working_dir: ' ', staged: true },
    ]);
  });

  it('groups per-scope significance; one entry may sit in both stacks', () => {
    const files = normalizeStatusFiles([
      { path: 'new.ts', index: ' ', working_dir: ' ', staged: false },
      { path: 'both.ts', index: 'M', working_dir: 'M' },
      { path: 'staged-only.ts', index: 'D', working_dir: ' ' },
      { path: 'worktree-only.ts', index: ' ', working_dir: 'M' },
    ]);
    const grouped = groupedStatusFiles(statusOf(files));
    expect(grouped.staged.map((entry) => entry.path)).toEqual(['both.ts', 'staged-only.ts']);
    expect(grouped.working.map((entry) => entry.path)).toEqual(['new.ts', 'both.ts', 'worktree-only.ts']);
    const untracked = files[0]!;
    expect(isStagedStatusFile(untracked)).toBe(false);
    expect(isWorkingStatusFile(untracked)).toBe(true);
    expect(statusSymbol({ path: 'new.ts', index: '?', working_dir: '?' })).toBe('A');
    expect(statusSymbol({ path: 'x', index: 'M', working_dir: 'M' })).toBe('M');
  });
});
