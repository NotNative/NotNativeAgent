// SPDX-License-Identifier: Apache-2.0
/**
 * Git domain client (doc 06 §5.6/§6.4 + doc 03 §5.13/§5.16): status, log,
 * branches, per-file diff/patch, stage/unstage/discard, hunk application,
 * commit. §11.1 stale windows live in the store; this module is transport.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

export interface GitStatusFile { path: string; index: string; working_dir: string }
export interface GitStatus {
  isGitRepository: boolean;
  branch: string | null;
  trackingBehind: number;
  trackingAhead: number;
  files: GitStatusFile[];
  mergeInProgress?: boolean;
  rebaseInProgress?: boolean;
}
export interface GitBranch {
  current: string | null;
  local: { name: string; tracking?: string }[];
  remote: string[];
  unpushedCount?: number;
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await runtimeFetch(url);
  if (!response.ok) return null;
  return await response.json() as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await runtimeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(parsed?.error ?? `git failed (${response.status})`);
  }
  return parsed as T;
}

export async function fetchGitStatus(directory: string, mode: 'light' | 'full'): Promise<GitStatus | null> {
  return getJson<GitStatus>(`/api/git/status?directory=${encodeURIComponent(directory)}&mode=${mode}`);
}

export async function fetchGitBranches(directory: string): Promise<GitBranch | null> {
  return getJson<GitBranch>(`/api/git/branches?directory=${encodeURIComponent(directory)}`);
}

export async function fetchGitLog(directory: string, maxCount = 50): Promise<{ commits: { hash: string; subject: string; author: string; date: string }[] } | null> {
  return getJson(`/api/git/log?directory=${encodeURIComponent(directory)}&maxCount=${maxCount}`);
}

export async function fetchGitDiff(directory: string, path: string, options: { staged: boolean; contextLines: number }): Promise<{ diff: string } | null> {
  const url = `/api/git/diff?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}&staged=${options.staged}&contextLines=${options.contextLines}`;
  return getJson(url);
}

export async function fetchGitFileDiff(directory: string, path: string, staged: boolean): Promise<{ original: string | null; modified: string | null; isBinary: boolean } | null> {
  return getJson(`/api/git/file-diff?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}&staged=${staged}`);
}

export async function stageGitFiles(directory: string, paths: string[]): Promise<void> {
  await postJson(`/api/git/stage?directory=${encodeURIComponent(directory)}`, { paths });
}

export async function unstageGitFiles(directory: string, paths: string[]): Promise<void> {
  await postJson(`/api/git/unstage?directory=${encodeURIComponent(directory)}`, { paths });
}

export async function discardGitFiles(directory: string, paths: string[]): Promise<void> {
  await postJson(`/api/git/discard?directory=${encodeURIComponent(directory)}`, { paths });
}

export async function applyGitHunk(directory: string, path: string, patch: string, action: 'stage' | 'unstage' | 'discard'): Promise<void> {
  await postJson(`/api/git/apply-hunk?directory=${encodeURIComponent(directory)}`, { path, patch, action });
}

export async function commitChanges(directory: string, message: string): Promise<{ committed: true; hash: string | null }> {
  return postJson(`/api/git/commit?directory=${encodeURIComponent(directory)}`, { message });
}

/** §6.3/§11.1 status derivation per §2.2 (index/working_dir codes). */
export function isStagedStatusFile(entry: GitStatusFile): boolean {
  return (entry.index !== '' && entry.index !== ' ' && entry.index !== '?');
}

export function isWorkingStatusFile(entry: GitStatusFile): boolean {
  return entry.working_dir !== '' && entry.working_dir !== ' ' ? true : entry.index === '?';
}

export function statusSymbol(entry: GitStatusFile): 'M' | 'A' | 'D' | 'R' | 'C' | 'U' {
  const code = entry.index !== ' ' && entry.index !== '' ? entry.index : entry.working_dir;
  if (code === 'A' || code === '?') return 'A';
  if (code === 'D') return 'D';
  if (code === 'R') return 'R';
  if (code === 'C') return 'C';
  if (code === 'U' || code === 'AA' || code === 'DD') return 'U';
  return 'M';
}
