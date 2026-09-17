// SPDX-License-Identifier: Apache-2.0
/**
 * Git worktree routes v1 (doc 03 §5.13 #61/63/66): list (empty only when
 * not a repo; 500 on real failure), create (mode 'new': `worktree add -b`
 * at the managed root; upstream/fetch-fallback, validate + preview =
 * registered), remove (registered target + dirty-worktree refusal carries
 * git's stderr; optional local branch delete). Callers keep the last
 * topology on failure (doc 06 §7).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { Hono } from 'hono';
import { ENV as dataEnv } from '../env.ts';
import { isGitRepository } from './git.ts';

const GIT_TIMEOUT_MS = 30_000;

export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  linked: boolean;
}

export function registerGitWorktreeRoutes(app: Hono): void {
  app.get('/api/git/worktrees', (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    if (!isGitRepository(directory)) return Response.json({ worktrees: [] });
    const probe = git(['worktree', 'list', '--porcelain'], directory);
    if (probe.status !== 0) return Response.json({ error: probe.stderr.trim() || 'git worktree list failed' }, { status: 500 });
    return Response.json({ worktrees: parsePorcelainWorktrees(probe.stdout) });
  });

  app.post('/api/git/worktrees', async (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    if (!isGitRepository(directory)) return Response.json({ error: 'not a git repository' }, { status: 400 });
    return createWorktreeEntry(directory, await readJsonBody(context.req));
  });

  app.delete('/api/git/worktrees', async (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    return removeWorktreeEntry(directory, await readJsonBody(context.req));
  });
}

/** POST create v1 (doc 03 section 5.13 #63, mode 'new' only): the branch name
 * is required (git validates the ref itself) and the worktree name is always
 * slug-sanitized so the managed root path cannot escape via '..', separators
 * or a drive prefix in a caller-supplied name. */
function createWorktreeEntry(projectRoot: string, body: Record<string, unknown>): Response {
  const branchName = textOf(body['branchName']).trim();
  if (textOf(body['mode']) !== 'new') return Response.json({ error: 'mode must be "new"' }, { status: 400 });
  if (branchName.length === 0) return Response.json({ error: 'branchName is required' }, { status: 400 });
  const wantedName = textOf(body['worktreeName']).trim().length > 0 ? textOf(body['worktreeName']).trim() : branchName;
  const name = slugOf(wantedName);
  if (name.length === 0) return Response.json({ error: 'worktree name is invalid' }, { status: 400 });
  const path = worktreePath(projectRoot, name);
  const args = ['worktree', 'add', '-b', branchName, path];
  const startRef = textOf(body['startRef']).trim();
  if (startRef.length > 0) args.push(startRef);
  const created = git(args, projectRoot);
  if (created.status !== 0) return Response.json({ error: created.stderr.trim() || 'git worktree add failed' }, { status: 500 });
  const head = git(['rev-parse', 'HEAD'], path);
  return Response.json({ worktree: { path, head: head.status === 0 ? head.stdout.trim() : null, branch: branchName, detached: false, linked: true } });
}

/** DELETE remove v1 (doc 03 section 5.13 #66): registered linked targets
 * only; the primary entry and unknown paths are 404. */
function removeWorktreeEntry(projectRoot: string, body: Record<string, unknown>): Response {
  if (!isGitRepository(projectRoot)) return Response.json({ error: 'unknown worktree' }, { status: 404 });
  const probe = git(['worktree', 'list', '--porcelain'], projectRoot);
  if (probe.status !== 0) return Response.json({ error: probe.stderr.trim() || 'git worktree list failed' }, { status: 500 });
  const parsed = parsePorcelainWorktrees(probe.stdout);
  const entry = parsed.find((worktree) => samePath(worktree.path, textOf(body['directory'])));
  if (entry === undefined || entry.linked === false) return Response.json({ error: 'unknown worktree' }, { status: 404 });
  // Removing runs from the PRIMARY worktree: a caller inside the doomed
  // worktree loses its cwd mid-removal ("not a git repository" afterwards).
  const primaryPath = parsed[0]!.path;
  const removed = removeWorktreeAt(entry.path, primaryPath); // no --force: a dirty worktree is protected server-side
  if (removed.status !== 0) {
    const finalized = finalizePartiallyRemoved(entry.path, primaryPath);
    if (!finalized) return Response.json({ error: removed.stderr.trim() || 'git worktree remove failed' }, { status: 500 });
  }
  return Response.json({ success: true, branch: dropLocalBranch(primaryPath, entry.branch, body) });
}

/** Optional local-branch drop AFTER the worktree is gone: the branch lives in
 * the repo, never in the dead worktree directory. */
function dropLocalBranch(cwd: string, branch: string | null, body: Record<string, unknown>): string | null {
  if (body['deleteLocalBranch'] !== true || branch === null) return null;
  const drop = git(['branch', '-D', branch], cwd);
  return drop.status === 0 ? branch : null;
}

function parsePorcelainWorktrees(stdout: string): GitWorktreeEntry[] {
  const lines = stdout.replace(/\r\n/gu, '\n'); // Windows stdout safety: git may emit CRLF
  const entries: GitWorktreeEntry[] = [];
  for (const block of lines.split('\n\n')) {
    const rows = block.split('\n').filter((row) => row.length > 0);
    if (rows.length === 0 || !rows[0]!.startsWith('worktree ')) continue;
    const entry: GitWorktreeEntry = { path: rows[0]!.slice('worktree '.length), head: null, branch: null, detached: false, linked: entries.length > 0 };
    for (const row of rows.slice(1)) {
      if (row.startsWith('HEAD ')) entry.head = row.slice('HEAD '.length);
      else if (row.startsWith('branch ')) entry.branch = row.slice('branch refs/heads/'.length);
      else if (row === 'detached') entry.detached = true;
    }
    entries.push(entry);
  }
  return entries;
}

function readJsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return req.json().then((body) => (typeof body === 'object' && body !== null ? body as Record<string, unknown> : {})).catch(() => ({}));
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll('/', '\\') === right.replaceAll('/', '\\') || left === right;
}

function slugOf(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^[-.]+|[-]+$/gu, '').slice(0, 60);
}

function worktreePath(projectRoot: string, name: string): string {
  const projectName = slugOf(projectRoot.split(/[\\/]/u).filter((piece) => piece.length > 0).pop() ?? 'proj');
  return joinPath(dataEnv.dataDir, 'git-worktrees', projectName, name);
}

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', windowsHide: true });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? 'git failed' };
  }
}

/** Windows transient file-lock race: a clean remove can lose the rmdir
 * ("failed to delete … prune" or "Permission denied") — bounded retries
 * absorb it; a dirty worktree still fails deterministically (no --force). */
function removeWorktreeAt(path: string, cwd: string): { status: number; stdout: string; stderr: string } {
  let attempt = git(['worktree', 'remove', path], cwd);
  for (let round = 0; attempt.status !== 0 && round < 4 && isTransientRemoval(attempt.stderr); round += 1) {
    execFileSync('ping', ['-n', '2', '127.0.0.1'], { windowsHide: true, timeout: 5_000 }); // ≈1 s settle for handle release
    attempt = git(['worktree', 'remove', path], cwd);
  }
  return attempt;
}

function isTransientRemoval(stderr: string): boolean {
  return stderr.includes('failed to delete') || stderr.includes('Permission denied');
}

/** A partially-failed removal can leave a DEAD registration (files gone,
 * `git worktree list` still shows it): prune + finish the physical delete.
 * Returns true only when the worktree is actually gone. */
function finalizePartiallyRemoved(path: string, cwd: string): boolean {
  const probe = git(['worktree', 'list', '--porcelain'], cwd);
  if (probe.status !== 0) return false;
  if (parsePorcelainWorktrees(probe.stdout).some((worktree) => samePath(worktree.path, path))) return false;
  git(['worktree', 'prune'], cwd);
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* the physical cleanup lost — keep the failure */ }
  return !existsSync(path);
}

export const __gitWorktreeTestables = { parsePorcelainWorktrees, slugOf, samePath };
