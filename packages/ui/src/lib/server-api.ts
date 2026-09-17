// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime-request helpers for NND-owned server routes (doc 03 §5.14/§5.13).
 * These LIVE on the app origin (/api/...) — NOT the harness proxy — so they
 * ride plain runtimeFetch with the `/api` base.
 */
import { runtimeFetch } from './runtime-fetch.ts';

export interface FsEntry { path: string; name: string; isDirectory: boolean }
export interface FsSearchResult { path: string; query: string; entries: FsEntry[] }
export interface GitStatusResult {
  isGitRepository: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: { path: string; staged: boolean }[];
}

/** Bounded workspace filename search (relative paths for @mentions). */
export async function fsSearch(directory: string, query: string, limit = 25): Promise<FsEntry[]> {
  const url = `/api/fs/search?directory=${encodeURIComponent(directory)}&query=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await runtimeFetch(url);
  if (!response.ok) return [];
  const body = await response.json() as FsSearchResult;
  return Array.isArray(body.entries) ? body.entries : [];
}

/** Workspace-in-scoped directory listing (relative paths, caller space). */
export async function fsList(directory: string, path: string): Promise<FsEntry[]> {
  const url = `/api/fs/list?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`;
  const response = await runtimeFetch(url);
  if (!response.ok) return [];
  const body = await response.json() as { entries: FsEntry[] };
  return Array.isArray(body.entries) ? body.entries : [];
}

/** §5.13 #12: non-repo answers the payload (isGitRepository:false), not an error. */
export async function gitStatus(directory: string): Promise<GitStatusResult | null> {
  const url = `/api/git/status?directory=${encodeURIComponent(directory)}&mode=light`;
  const response = await runtimeFetch(url);
  if (!response.ok) return null;
  return await response.json() as GitStatusResult;
}

/** Doc 03 §5.13 #61: worktree list (empty when not a repo). null = route failure. */
export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  linked: boolean;
}

export async function listWorktrees(directory: string): Promise<GitWorktreeEntry[] | null> {
  const url = `/api/git/worktrees?directory=${encodeURIComponent(directory)}`;
  const response = await runtimeFetch(url);
  if (!response.ok) return null;
  const body = await response.json() as { worktrees?: GitWorktreeEntry[] };
  return Array.isArray(body.worktrees) ? body.worktrees : [];
}

export interface WorktreeCreatePayload {
  mode: 'new';
  branchName: string;
  worktreeName?: string;
  startRef?: string;
}

/** §5.13 #63: create v1 (mode 'new'); validation/preview + upstream/fallback
 * semantics are registered (E-06-12). */
export async function createWorktree(directory: string, payload: WorktreeCreatePayload): Promise<{ ok: true; worktree: GitWorktreeEntry } | { ok: false; error: string }> {
  const url = `/api/git/worktrees?directory=${encodeURIComponent(directory)}`;
  const response = await runtimeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { worktree?: GitWorktreeEntry; error?: string };
  if (!response.ok) return { ok: false, error: body.error ?? 'create failed' };
  if (body.worktree === undefined) return { ok: false, error: 'create failed' };
  return { ok: true, worktree: body.worktree };
}

/** §5.13 #66: remove (dirty worktrees are refused server-side, no --force). */
export async function removeWorktree(directory: string, worktreePath: string, deleteLocalBranch: boolean): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> {
  const url = `/api/git/worktrees?directory=${encodeURIComponent(directory)}`;
  const response = await runtimeFetch(url, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: worktreePath, deleteLocalBranch }),
  });
  const body = await response.json().catch(() => ({})) as { success?: boolean; branch?: string | null; error?: string };
  if (!response.ok || body.success !== true) return { ok: false, error: body.error ?? 'remove failed' };
  return { ok: true, branch: body.branch ?? null };
}
