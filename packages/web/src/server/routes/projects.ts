// SPDX-License-Identifier: Apache-2.0
/**
 * P4-2 routes (doc 03 §5.6/§5.13/§5.15 subset): canonical settings CRUD with
 * the deferred-restart response shape, git log/branches read family, and the
 * projects config + project-context read/write core. Single JSON store per
 * entity under the data dir; writes are atomic tmp+rename (§5.14 write rule).
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join as joinPath } from 'node:path';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';

const SETTINGS_FILE = joinPath(ENV.dataDir, 'settings.json');
const PROJECTS_DIR = joinPath(ENV.dataDir, 'projects');
const RESTART_MESSAGE = 'Configuration is saved on disk. Restart your connected OpenCode server to apply the changes.';

/** §5.6 deferred-restart shape for the EXTERNAL-harness case (mock + remote
 * NNA are external; managed restart lands with the doc 09 embed). */
function deferredRestart(): { requiresReload: boolean; requiresRestart: boolean; message: string } {
  return { requiresReload: false, requiresRestart: true, message: RESTART_MESSAGE };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic tmp+rename write (§5.14 write family rule; 0600 per §5.6). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/** Shallow-plus-one merge: undefined deletes a top-level key, objects merge
 * one level deep, everything else replaces. Deliberately simple; deep-merge
 * semantics stay out until the settings registry (P5) demands them. */
function mergeSettings(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = merged[key];
      merged[key] = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
    } else merged[key] = value;
  }
  return merged;
}

export function registerSettingsRoutes(app: Hono): void {
  app.get('/api/config/settings', async (c) => {
    const surface = c.req.header('x-nnd-surface') ?? 'web';
    const settings = await readJson<Record<string, unknown>>(SETTINGS_FILE, {});
    return c.json({ ...settings, surface });
  });
  app.put('/api/config/settings', async (c) => {
    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json() as Record<string, unknown>;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('shape');
    } catch {
      return c.json({ error: 'settings patch must be a JSON object' }, 400);
    }
    const current = await readJson<Record<string, unknown>>(SETTINGS_FILE, {});
    const merged = mergeSettings(current, patch);
    await writeJsonAtomic(SETTINGS_FILE, merged);
    return c.json({ ...deferredRestart(), settings: merged });
  });
  app.get('/api/config/themes', async (c) => {
    const themesDir = joinPath(ENV.dataDir, 'themes');
    // 512 KiB per file cap (§5.6); malformed JSON files are skipped
    const themes: unknown[] = [];
    if (existsSync(themesDir)) {
      const { readdirSync, statSync, readFileSync } = await import('node:fs');
      for (const name of readdirSync(themesDir)) {
        const path = joinPath(themesDir, name);
        try {
          const stat = statSync(path, { throwIfNoEntry: false });
          if (!stat?.isFile() || stat.size > 512 * 1024 || !name.endsWith('.json')) continue;
          themes.push(JSON.parse(readFileSync(path, 'utf8')));
        } catch { /* malformed theme skipped */ }
      }
    }
    return c.json({ themes });
  });
  app.post('/api/config/reload', (c) =>
    c.json({ requiresReload: false, requiresRestart: true, message: RESTART_MESSAGE }));
}

const PROJECT_ID = /^[a-zA-Z0-9_-]+$/u;

export function registerProjectsRoutes(app: Hono): void {
  app.get('/api/projects/:projectId/config', async (c) => {
    const projectID = c.req.param('projectId');
    if (!PROJECT_ID.test(projectID)) return c.json({ error: 'unsupported characters in projectId' }, 400);
    const path = joinPath(PROJECTS_DIR, `${projectID}.json`);
    return c.json(await readJson(path, { worktree: [], actions: [], starters: [] }));
  });
  app.put('/api/projects/:projectId/config', async (c) => {
    const projectID = c.req.param('projectId');
    if (!PROJECT_ID.test(projectID)) return c.json({ error: 'unsupported characters in projectId' }, 400);
    // §5.15 line 653: the request is an OBJECT — null/scalars/arrays are 400
    let body: unknown;
    try {
      body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    } catch {
      return c.json({ error: 'project config must be a JSON object' }, 400);
    }
    const path = joinPath(PROJECTS_DIR, `${projectID}.json`);
    await writeJsonAtomic(path, body);
    return c.json(body);
  });
  app.get('/api/project-context/:projectId', async (c) => {
    const projectID = c.req.param('projectId');
    if (!PROJECT_ID.test(projectID)) return c.json({ error: 'unsupported characters in projectId' }, 400);
    const path = joinPath(PROJECTS_DIR, `${projectID}.json`);
    const config = await readJson<Record<string, unknown>>(path, {});
    return c.json({
      notes: (config.notes as unknown[]) ?? [],
      todos: (config.todos as unknown[]) ?? [],
      plans: (config.plans as unknown[]) ?? [],
    });
  });
  app.put('/api/project-context/:projectId/todos', async (c) => {
    const projectID = c.req.param('projectId');
    if (!PROJECT_ID.test(projectID)) return c.json({ error: 'unsupported characters in projectId' }, 400);
    let todos: unknown;
    try {
      const body = await c.req.json() as { todos?: unknown };
      todos = body.todos;
      if (!Array.isArray(todos)) throw new Error('shape');
    } catch {
      return c.json({ error: 'todos must be an array' }, 400);
    }
    const path = joinPath(PROJECTS_DIR, `${projectID}.json`);
    const config = await readJson<Record<string, unknown>>(path, {});
    await writeJsonAtomic(path, { ...config, todos });
    return c.json({ saved: true });
  });
}

export interface GitBranchesPayload { current: string | null; local: string[]; remote: string[] }

/** §5.13 #50/§68 (P4-2 subset): log with stats + branch list. Local refs list
 * all; remotes list ACTIVE branches only (heads, no pulls/tags). */
export function registerGitReadRoutes(app: Hono): void {
  app.get('/api/git/log', (c) => gitLog(c.req.query()));
  app.get('/api/git/branches', (c) => gitBranches(c.req.query()));
}

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, timeout: 10_000, encoding: 'utf8', windowsHide: true });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? 'git failed' };
  }
}

export interface GitLogEntry { hash: string; author: string; date: number; subject: string; files: number; additions: number; deletions: number }

function gitLog(query: { directory?: string; maxCount?: string }): Response {
  const repository = query.directory;
  if (!repository) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
  const maxCount = Math.min(500, Math.max(1, Number(query.maxCount ?? 50) || 50));
  // %x01 sentinel: stat-less commits (merges, empty) join headers with a
  // single \n, so block boundaries need a prefix numstat can't emit (P1).
  const sentinel = '\u0001';
  const result = git(['log', `--max-count=${maxCount}`, '--pretty=format:%x01%H%x00%an%x00%ct%x00%s', '--numstat'], repository);
  if (result.status !== 0 && !isNotRepo(result.stderr)) {
    return Response.json({ error: result.stderr || 'git log failed' }, { status: 500 });
  }
  // not-a-repo: git log fails; §5.13 rule #12 says non-repo payload applies to
  // the STATUS route shape — log answers the empty list instead of 500 text.
  const empty = { isGitRepository: false, commits: [] as GitLogEntry[] };
  if (isNotRepo(result.stderr)) return Response.json(empty);
  return Response.json({ isGitRepository: true, commits: parseLog(result.stdout.replace(/^\n+/u, ''), sentinel, maxCount) });
}

function revParse(directory: string): boolean | null {
  const result = git(['rev-parse', '--is-inside-work-tree'], directory);
  if (result.status !== 0) return isNotRepo(result.stderr) ? false : null;
  return result.stdout.trim() === 'true';
}

function isNotRepo(stderr: string): boolean {
  return /not a git repository/iu.test(stderr);
}

function parseLog(stdout: string, sentinel: string, maxCount: number): GitLogEntry[] {
  const commits: GitLogEntry[] = [];
  const blocks = stdout.split(sentinel).slice(1);
  for (const head of blocks.slice(0, maxCount)) {
    const lines = head.split(/\r?\n/u);
    const statBlock = lines[0] ?? '';
    const numstat = lines.slice(1);
    const fields = statBlock.split('\u0000');
    const hash = fields[0] ?? '';
    if (!hash) continue;
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of numstat) {
      if (line.length === 0) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        files += 1;
        additions += Number(parts[0] || 0) || 0;
        deletions += Number(parts[1] || 0) || 0;
      }
    }
    commits.push({ hash, author: fields[1] ?? '', date: Number(fields[2]) * 1000 || 0, subject: fields.slice(3).join(' '), files, additions, deletions });
  }
  return commits;
}

function gitBranches(query: { directory?: string }): Response {
  const repository = query.directory;
  if (!repository) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
  const state = revParse(repository);
  if (state === false) return Response.json({ isGitRepository: false, current: null, local: [], remote: [] });
  if (state === null) return Response.json({ error: 'git rev-parse failed' }, { status: 500 });
  const result = git(['branch', '-a', '--format=%(objectname:short)%(HEAD)%00%(refname)'], repository);
  if (result.status !== 0) return Response.json({ error: result.stderr || 'git branches failed' }, { status: 500 });
  const local: string[] = [];
  const remote: string[] = [];
  let current: string | null = null;
  for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    const [marker, ref] = line.split('\u0000');
    if (!ref) continue;
    const name = ref.replace(/^refs\//u, '').replace(/^remotes\//u, '').replace(/\^0$/u, '');
    const isCurrent = marker !== undefined && marker.length >= 1 && marker.endsWith('*');
    const isRemote = ref.startsWith('refs/remotes/');
    const refName = isRemote ? name.replace(/^remotes\/[^/]+\//u, '') : name.replace(/^heads\//u, '');
    if (isRemote) {
      // a symbolic origin/HEAD pointer is not a branch — excluded everywhere
      if (!refName.endsWith('HEAD')) remote.push(refName);
      continue;
    }
    if (refName.startsWith('(')) continue; // detached HEAD pseudo-entry: no fabricated branch
    local.push(refName);
    if (isCurrent) current = refName;
  }
  return Response.json({ isGitRepository: true, current, local: [...new Set(local)].sort(), remote: [...new Set(remote)].sort() });
}

