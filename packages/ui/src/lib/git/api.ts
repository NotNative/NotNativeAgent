// SPDX-License-Identifier: Apache-2.0
/** Runtime-neutral Git facade. Host transports are supplied through RuntimeAPIs. */
import type { GitApi } from '../api/types.ts';
import { getRuntimeAPIs } from '../api/registry.ts';
import type { GitBranch, GitStatus } from './types.ts';

export type { GitBranch, GitStatus, GitStatusFile } from './types.ts';
export { isStagedStatusFile, isWorkingStatusFile, normalizeStatusFiles, statusSymbol } from './status.ts';

function git(): GitApi { return getRuntimeAPIs().git; }

export function fetchGitStatus(directory: string, mode: 'light' | 'full'): Promise<GitStatus | null> {
  return git().fetchGitStatus(directory, mode);
}
export function fetchGitBranches(directory: string): Promise<GitBranch | null> {
  return git().fetchGitBranches(directory);
}
export function checkoutLocalBranch(directory: string, branch: string, expectedBranch: string) {
  return git().checkoutLocalBranch(directory, branch, expectedBranch);
}
export function createLocalBranch(directory: string, name: string, expectedBranch: string) {
  return git().createLocalBranch(directory, name, expectedBranch);
}
export function fetchGitLog(directory: string, maxCount = 50) {
  return git().fetchGitLog(directory, maxCount);
}
export function fetchGitDiff(directory: string, path: string, options: { staged: boolean; contextLines: number }) {
  return git().fetchGitDiff(directory, path, options);
}
export function fetchGitFileDiff(directory: string, path: string, staged: boolean) {
  return git().fetchGitFileDiff(directory, path, staged);
}
export function stageGitFiles(directory: string, paths: string[]): Promise<void> {
  return git().stageGitFiles(directory, paths);
}
export function unstageGitFiles(directory: string, paths: string[]): Promise<void> {
  return git().unstageGitFiles(directory, paths);
}
export function discardGitFiles(directory: string, paths: string[]): Promise<void> {
  return git().discardGitFiles(directory, paths);
}
export function applyGitHunk(directory: string, path: string, patch: string, action: 'stage' | 'unstage' | 'discard'): Promise<void> {
  return git().applyGitHunk(directory, path, patch, action);
}
export function commitChanges(directory: string, message: string) {
  return git().commitChanges(directory, message);
}
export function syncGitBranch(directory: string) {
  return git().syncGitBranch(directory);
}
