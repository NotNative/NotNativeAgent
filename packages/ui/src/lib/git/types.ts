// SPDX-License-Identifier: Apache-2.0
export interface GitStatusFile { path: string; index: string; working_dir: string; staged?: boolean }
export interface GitStatus {
  isGitRepository: boolean;
  workspacePrefix?: string;
  branch: string | null;
  upstream?: string | null;
  upstreamGone?: boolean;
  trackingBehind: number;
  trackingAhead: number;
  files: GitStatusFile[];
  mergeInProgress?: boolean;
  rebaseInProgress?: boolean;
}
export interface GitBranch {
  isGitRepository?: boolean;
  current: string | null;
  local: string[];
  remote: string[];
}

export interface GitApi {
  fetchGitStatus(directory: string, mode: 'light' | 'full'): Promise<GitStatus | null>;
  fetchGitBranches(directory: string): Promise<GitBranch | null>;
  checkoutLocalBranch(directory: string, branch: string, expectedBranch: string): Promise<{ branch: string; switched: boolean }>;
  createLocalBranch(directory: string, name: string, expectedBranch: string): Promise<{ branch: string; created: boolean }>;
  fetchGitLog(directory: string, maxCount?: number): Promise<{ isGitRepository?: boolean; commits: { hash: string; subject: string; author: string; date: number }[] } | null>;
  fetchGitDiff(directory: string, path: string, options: { staged: boolean; contextLines: number }): Promise<{ diff: string } | null>;
  fetchGitFileDiff(directory: string, path: string, staged: boolean): Promise<{ original: string | null; modified: string | null; isBinary: boolean } | null>;
  stageGitFiles(directory: string, paths: string[]): Promise<void>;
  unstageGitFiles(directory: string, paths: string[]): Promise<void>;
  discardGitFiles(directory: string, paths: string[]): Promise<void>;
  applyGitHunk(directory: string, path: string, patch: string, action: 'stage' | 'unstage' | 'discard'): Promise<void>;
  commitChanges(directory: string, message: string): Promise<{ committed: true; hash: string | null }>;
  syncGitBranch(directory: string): Promise<{ synced: true; branch: string; pulled: boolean; pushed: boolean }>;
  fetchGitStashes(directory: string): Promise<{ stashes: { ref: string; subject: string }[] } | null>;
  createGitStash(directory: string, message: string | null): Promise<{ stashed: boolean; empty: boolean }>;
  applyGitStash(directory: string, ref: string, drop: boolean): Promise<{ applied: boolean; dropped: boolean }>;
}
