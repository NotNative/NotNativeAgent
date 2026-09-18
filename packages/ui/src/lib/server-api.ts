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

// ---------- terminal command plane (doc 07 section 3.7) ----------

export interface TerminalShellOptionResponse { id: string; name: string; supportsLogin: boolean }

export async function listTerminalShells(): Promise<TerminalShellOptionResponse[]> {
  const response = await runtimeFetch('/api/terminal/shells');
  if (!response.ok) return [];
  const body = await response.json() as TerminalShellOptionResponse[];
  return Array.isArray(body) ? body : [];
}

export interface TerminalServerSessionResponse {
  sessionId: string;
  cwd: string;
  status: 'running' | 'exited';
  createdAt: number;
  mode: 'interactive' | 'command';
  purpose: { type: 'terminal' | 'project-action'; actionId?: string; executionId?: string | null };
}

/** cwd '' observes ALL directories. Listings never include command text. */
export async function listTerminalSessions(cwd = ''): Promise<TerminalServerSessionResponse[]> {
  const query = cwd.length > 0 ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const response = await runtimeFetch(`/api/terminal/sessions${query}`);
  if (!response.ok) return [];
  const body = await response.json() as { sessions?: TerminalServerSessionResponse[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export interface CreateTerminalRequest {
  cwd: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: string;
  loginShell?: boolean;
  purpose?: { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };
  mode?: 'interactive' | 'command';
  command?: string;
}

export type TerminalCreateResult = {
  ok: true;
  sessionId: string;
  cols: number;
  rows: number;
  status: string;
  mode: 'interactive' | 'command';
  purpose: TerminalServerSessionResponse['purpose'];
} | {
  ok: false;
  error: string;
  code?: string;
}

export async function createTerminalSession(request: CreateTerminalRequest): Promise<TerminalCreateResult> {
  const response = await runtimeFetch('/api/terminal/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({})) as {
    sessionId?: string;
    cols?: number;
    rows?: number;
    status?: string;
    mode?: 'interactive' | 'command';
    purpose?: TerminalServerSessionResponse['purpose'];
    error?: string;
    code?: string;
  };
  if (!response.ok) return { ok: false, error: body.error ?? 'create failed', code: body.code };
  if (body.sessionId === undefined) return { ok: false, error: 'create failed' };
  return {
    ok: true,
    sessionId: body.sessionId,
    cols: body.cols ?? 80,
    rows: body.rows ?? 24,
    status: body.status ?? 'running',
    mode: body.mode ?? 'interactive',
    purpose: body.purpose ?? { type: 'terminal' },
  };
}

export async function resizeTerminalSession(sessionId: string, cols: number, rows: number): Promise<boolean> {
  const response = await runtimeFetch(`/api/terminal/${encodeURIComponent(sessionId)}/resize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cols, rows }),
  });
  return response.ok;
}

export async function restartTerminalSession(sessionId: string, options: { cwd?: string; cols?: number; rows?: number } = {}): Promise<boolean> {
  const response = await runtimeFetch(`/api/terminal/${encodeURIComponent(sessionId)}/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options),
  });
  return response.ok;
}

export async function closeTerminalSession(sessionId: string): Promise<boolean> {
  const response = await runtimeFetch(`/api/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  return response.ok;
}

export async function forceKillTerminals(scope: { sessionId?: string; cwd?: string }): Promise<{ ok: boolean; killedCount: number }> {
  const response = await runtimeFetch('/api/terminal/force-kill', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope),
  });
  if (!response.ok) return { ok: false, killedCount: 0 };
  const body = await response.json().catch(() => ({})) as { killedCount?: number };
  return { ok: true, killedCount: body.killedCount ?? 0 };
}

export async function touchTerminalSessions(sessionIds: string[]): Promise<void> {
  await runtimeFetch('/api/terminal/touch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds }),
  }).catch(() => undefined); // swallowed by design: the server decides freshness
}
