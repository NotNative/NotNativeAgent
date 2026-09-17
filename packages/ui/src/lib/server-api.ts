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
