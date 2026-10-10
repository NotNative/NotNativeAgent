// SPDX-License-Identifier: Apache-2.0
/**
 * Git domain client (doc 06 §5.6/§6.4 + doc 03 §5.13/§5.16): status, log,
 * branches, per-file diff/patch, stage/unstage/discard, hunk application,
 * commit. §11.1 stale windows live in the store; this module is transport.
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import type { GitBranch, GitStatus } from './types.ts';
import { normalizeStatusFiles } from './status.ts';
export type { GitBranch, GitStatus, GitStatusFile } from './types.ts';

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
  const status = await getJson<GitStatus>(`/api/git/status?directory=${encodeURIComponent(directory)}&mode=${mode}`);
  if (status === null || !Array.isArray(status.files)) return status;
  return { ...status, files: normalizeStatusFiles(status.files) };
}

export async function fetchGitBranches(directory: string): Promise<GitBranch | null> {
  return getJson<GitBranch>(`/api/git/branches?directory=${encodeURIComponent(directory)}`);
}

export async function checkoutLocalBranch(directory: string, branch: string, expectedBranch: string): Promise<{ branch: string; switched: boolean }> {
  return postJson(`/api/git/checkout?directory=${encodeURIComponent(directory)}`, { branch, expectedBranch });
}

export async function createLocalBranch(directory: string, name: string, expectedBranch: string): Promise<{ branch: string; created: boolean }> {
  return postJson(`/api/git/branches?directory=${encodeURIComponent(directory)}`, { name, expectedBranch });
}

export async function fetchGitLog(directory: string, maxCount = 50): Promise<{ isGitRepository?: boolean; commits: { hash: string; subject: string; author: string; date: number }[] } | null> {
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

export async function syncGitBranch(directory: string): Promise<{ synced: true; branch: string; pulled: boolean; pushed: boolean }> {
  return postJson(`/api/git/sync?directory=${encodeURIComponent(directory)}`, {});
}

export async function fetchGitStashes(directory: string): Promise<{ stashes: { ref: string; subject: string }[] } | null> {
  return getJson(`/api/git/stashes?directory=${encodeURIComponent(directory)}`);
}

export async function createGitStash(directory: string, message: string | null): Promise<{ stashed: boolean; empty: boolean }> {
  return postJson(`/api/git/stash?directory=${encodeURIComponent(directory)}`, { message });
}

export async function applyGitStash(directory: string, ref: string, drop: boolean): Promise<{ applied: boolean; dropped: boolean }> {
  return postJson(`/api/git/stash-apply?directory=${encodeURIComponent(directory)}`, { ref, drop });
}
