// SPDX-License-Identifier: Apache-2.0
/**
 * FileTree §2.2 status feed (SLICE-B): one fresh light-status fetch per 15 s
 * visible cadence, published into the shared git store so DiffView/GitView
 * reuse the same snapshot; refresh hints (file saves, fs mutations, git
 * mutations) restat immediately and force-refresh the affected tree
 * directories in place.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchGitStatus, normalizeStatusFiles, type GitStatusFile } from '../../lib/git/api.ts';
import { buildFileTreeStatusIndex, type FileTreeStatusIndex } from '../../lib/git/file-tree-status.ts';
import { useGitStore } from '../../lib/git/store';
import { useReviewRefreshHints, type ReviewRefreshHint } from '../../lib/git/refresh-hints';
import { workspaceRelativePath, parentDirOfPath } from '../../lib/files/workspace-paths.ts';
import { GIT_STATUS_POLL_INTERVAL_MS } from '../../lib/files/edit-support.ts';

/** Tree key → children map (FileTree scope); the hook reads keys only. */
type DirChildrenIndex = Record<string, unknown>;

/**
 * §2.2 status feed: one fresh light-status fetch per 15 s visible cadence,
 * published into the shared git store so DiffView/GitView reuse the same
 * snapshot; refresh hints (file saves, fs mutations, git mutations) restat
 * immediately and force-refresh the affected tree directories in place.
 */
export function useGitTreeStatus(
  root: string,
  runtimeKey: string,
  visible: boolean,
  loadDir: (dir: string, force?: boolean) => Promise<unknown>,
  childrenByDir: DirChildrenIndex,
): FileTreeStatusIndex {
  const [files, setFiles] = useState<readonly GitStatusFile[]>([]);
  const dirKeysRef = useRef(childrenByDir);
  dirKeysRef.current = childrenByDir;
  const loadDirRef = useRef(loadDir);
  loadDirRef.current = loadDir;
  const loadSeqRef = useRef(0);

  const restat = useCallback((): void => {
    const seq = ++loadSeqRef.current;
    void fetchGitStatus(root, 'light').then((status) => {
      if (seq !== loadSeqRef.current) return;
      const files = status !== null && Array.isArray(status.files) ? normalizeStatusFiles(status.files) : [];
      setFiles(files);
      if (status !== null) useGitStore.getState().applyStatus(root, status, 'light');
    });
  }, [root]);

  useEffect(() => {
    setFiles([]);
    return undefined;
  }, [root, runtimeKey]);

  useEffect(() => {
    if (!visible) return undefined;
    restat();
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      restat();
    }, GIT_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(poll);
  }, [root, runtimeKey, visible, restat]);

  // Refresh hints: restat for scope changes; fs mutations additionally
  // refresh ONLY the affected parent directories in place (§2.1 step 10).
  useReviewRefreshHints(root, visible, (hint: ReviewRefreshHint): void => {
    restat();
    if (hint.reasons.includes('file-save') && !hint.reasons.includes('fs-mutation')) return;
    const parents = parentDirsForHint(hint, root, dirKeysRef.current);
    for (const dir of parents) void loadDirRef.current(dir, true);
  });

  return useMemo(() => buildFileTreeStatusIndex(files), [files]);
}

/** Hint → DirectoryRequests keys: hint paths arrive workspace-relative
 * POSIX (publisher contract); the parent of each must match a LOADED tree
 * key by workspace-relative identity — mismatches fall back to root. */
function parentDirsForHint(hint: ReviewRefreshHint, root: string, childrenByDir: DirChildrenIndex): string[] {
  const keys = new Set<string>(['.']);
  for (const path of hint.paths ?? []) {
    const parent = parentDirOfPath(path.replaceAll('\\', '/'));
    keys.add(dirKeyForRelative(childrenByDir, root, parent === '' ? '.' : parent));
  }
  return [...keys];
}

function dirKeyForRelative(childrenByDir: DirChildrenIndex, root: string, relativeDir: string): string {
  if (relativeDir === '' || relativeDir === '.') return '.';
  for (const key of Object.keys(childrenByDir)) {
    if (workspaceRelativePath(root, key) === relativeDir) return key;
  }
  return '.';
}
