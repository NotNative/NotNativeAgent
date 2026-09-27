// SPDX-License-Identifier: Apache-2.0
/** A bounded, read-only working-tree snapshot for the deterministic tour. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import { realpath, resolveWithin } from './fs.ts';

export const SNAPSHOT_MAX_FILES = 60;
export const SNAPSHOT_MAX_HUNKS = 200;
export const SNAPSHOT_MAX_PATCH_BYTES = 750_000;
const TIMEOUT_MS = 10_000;
type Scope = 'staged' | 'working';
export type WalkthroughScope = 'all' | Scope;
type Entry = { path: string; oldPath?: string; index: string; working: string };
type Part = { scope: Scope; path: string; oldPath?: string; patch: string };
type Stop = { id: string; scope: Scope; path: string; oldPath?: string; header: string; oldStart: number; newStart: number; body: string };
type Snapshot = { signature: string; stops: Stop[]; fileCount: number; binaryFiles: number };

export class SnapshotError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

function git(cwd: string, args: string[], maxBuffer = SNAPSHOT_MAX_PATCH_BYTES + 65_536): string {
  try {
    return execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
      encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer, windowsHide: true,
    });
  } catch (cause) {
    const error = cause as { code?: string; stderr?: string };
    if (error.code === 'ENOBUFS') throw new SnapshotError('Diff exceeds walkthrough preview limit.', 413, 'diff-too-large');
    throw new SnapshotError(error.stderr?.trim() || 'Git snapshot failed.', 500, 'git-failed');
  }
}

function parseStatus(raw: string): Entry[] {
  const records = raw.split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i < records.length && records[i]; i += 1) {
    const line = records[i]!;
    if (line.startsWith('## ')) continue;
    if (line.length < 4 || line[2] !== ' ') throw new SnapshotError('Invalid Git status.', 500, 'invalid-status');
    const index = line[0]!;
    const working = line[1]!;
    const path = line.slice(3);
    const renamed = index === 'R' || index === 'C' || working === 'R' || working === 'C';
    const oldPath = renamed ? records[++i] : undefined;
    if (renamed && !oldPath) throw new SnapshotError('Invalid Git rename status.', 500, 'invalid-status');
    entries.push({ path, ...(oldPath ? { oldPath } : {}), index, working });
  }
  return entries;
}

function safePath(root: string, directory: string, path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const candidate = resolve(root, path);
  const workspace = realpath(directory);
  if (resolveWithin(workspace, candidate) === null) return false;
  // Git reads tracked content from the index/worktree without following the
  // final symlink. A symlink *parent* can escape the workspace, however.
  // Walk to an existing ancestor so deleted paths remain valid as well.
  let parent = dirname(candidate);
  while (!lstatSync(parent, { throwIfNoEntry: false })) {
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  return resolveWithin(workspace, realpath(parent)) !== null;
}

function capture(directory: string, root: string, prefix: string, selected: WalkthroughScope): { key: string; parts: Part[] } {
  const raw = git(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--', prefix ? `:(literal)${prefix}` : '.']);
  const entries = parseStatus(raw);
  const fileScopes = entries.reduce((count, entry) => count
    + Number(selected !== 'working' && entry.index !== ' ' && entry.index !== '?')
    + Number(selected !== 'staged' && (entry.working !== ' ' || entry.index === '?')), 0);
  if (fileScopes > SNAPSHOT_MAX_FILES) throw new SnapshotError(`Walkthrough supports at most ${SNAPSHOT_MAX_FILES} changed file scopes.`, 413, 'too-many-files');
  const parts: Part[] = [];
  let bytes = 0;
  const append = (part: Part): void => {
    bytes += Buffer.byteLength(part.patch);
    if (bytes > SNAPSHOT_MAX_PATCH_BYTES) throw new SnapshotError('Diff exceeds walkthrough preview limit.', 413, 'diff-too-large');
    parts.push(part);
  };
  for (const entry of entries) {
    const staged = selected !== 'working' && entry.index !== ' ' && entry.index !== '?';
    const working = selected !== 'staged' && (entry.working !== ' ' || entry.index === '?');
    if (!staged && !working) continue;
    if (!safePath(root, directory, entry.path)) throw new SnapshotError('Diff path escapes the workspace.', 403, 'access-denied');
    if (entry.oldPath && !safePath(root, directory, entry.oldPath)) throw new SnapshotError('Rename crosses the workspace boundary.', 403, 'access-denied');
    if (staged) append(diffPart(root, entry, 'staged'));
    if (working) append(diffPart(root, entry, 'working'));
  }
  parts.sort((a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope));
  // Preserve branch identity, but do not invalidate a scoped tour when only
  // the other side of the index/worktree changes. The selected patches below
  // still bind the signature to the actual bytes under review.
  // Ahead/behind tracking metadata may change after a fetch without changing
  // either local diff. Only the local branch identity belongs in this proof.
  const branch = (raw.split('\0', 1)[0] ?? '').replace(/(?:\.\.\..*| \[.*)$/u, '');
  const selectedStatus = entries.flatMap((entry) => {
    const staged = selected !== 'working' && entry.index !== ' ' && entry.index !== '?';
    const working = selected !== 'staged' && (entry.working !== ' ' || entry.index === '?');
    return [staged ? `staged\0${entry.index}\0${entry.path}\0${entry.oldPath ?? ''}` : '',
      working ? `working\0${entry.working}\0${entry.path}\0${entry.oldPath ?? ''}` : ''].filter(Boolean);
  });
  const key = createHash('sha256').update(selected).update('\0').update(branch).update('\0')
    .update(selectedStatus.join('\0\0')).update('\0')
    .update(parts.map(({ scope, path, oldPath, patch }) => `${scope}\0${path}\0${oldPath ?? ''}\0${patch}`).join('\0\0')).digest('hex');
  return { key, parts };
}

function diffPart(root: string, entry: Entry, scope: Scope): Part {
  let patch: string;
  if (entry.index === '?') {
    const path = resolve(root, entry.path);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotError('Untracked file is not a regular file.', 413, 'unsupported-untracked');
    if (info.size > SNAPSHOT_MAX_PATCH_BYTES) throw new SnapshotError('Diff exceeds walkthrough preview limit.', 413, 'diff-too-large');
    // git diff --no-index uses exit 1 to mean that the files differ.
    try {
      patch = execFileSync('git', ['-C', root, 'diff', '--no-index', '--no-color', '--binary', '--full-index', '--unified=3', '--', '/dev/null', entry.path],
        { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_PATCH_BYTES + 65_536, windowsHide: true });
    } catch (cause) {
      const result = cause as { status?: number; stdout?: string; code?: string };
      if (result.code === 'ENOBUFS') throw new SnapshotError('Diff exceeds walkthrough preview limit.', 413, 'diff-too-large');
      if (result.status !== 1 || typeof result.stdout !== 'string') throw new SnapshotError('Git untracked diff failed.', 500, 'git-failed');
      patch = result.stdout;
    }
  } else {
    const paths = [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])];
    patch = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index', '--unified=3', '--find-renames',
      ...(scope === 'staged' ? ['--cached'] : []), '--', ...paths.map((path) => `:(literal)${path}`)]);
  }
  return { scope, path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), patch };
}

function stopsFrom(parts: Part[]): Snapshot {
  const stops: Stop[] = [];
  const occurrences = new Map<string, number>();
  let binaryFiles = 0;
  for (const part of parts) {
    if (/^Binary files .* differ$|^GIT binary patch$/mu.test(part.patch)) { binaryFiles += 1; continue; }
    const lines = part.patch.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(lines[i]!);
      if (!match) continue;
      const header = lines[i]!;
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith('@@ ') && !lines[i]!.startsWith('diff --git ')) body.push(lines[i]!);
      i -= 1;
      if (body.at(-1) === '') body.pop();
      const hash = createHash('sha1').update(`${header}\n${body.join('\n')}`).digest('hex').slice(0, 8);
      const base = `${part.scope}:${part.path}:${hash}`;
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      stops.push({ id: count === 1 ? base : `${base}-${count}`, scope: part.scope, path: part.path,
        ...(part.oldPath ? { oldPath: part.oldPath } : {}), header, oldStart: Number(match[1]), newStart: Number(match[2]), body: body.join('\n') });
      if (stops.length > SNAPSHOT_MAX_HUNKS) throw new SnapshotError(`Walkthrough supports at most ${SNAPSHOT_MAX_HUNKS} hunks.`, 413, 'too-many-hunks');
    }
  }
  return { signature: '', stops, fileCount: parts.length, binaryFiles };
}

export function getWalkthroughSnapshot(directory: string, afterFirstCapture?: () => void, selected: WalkthroughScope = 'all'): Snapshot {
  if (!['all', 'staged', 'working'].includes(selected)) throw new SnapshotError('Invalid walkthrough scope.', 400, 'invalid-scope');
  const root = git(directory, ['rev-parse', '--show-toplevel'], 4096).trim();
  if (!root || !isAbsolute(root)) throw new SnapshotError('No Git repository is available.', 404, 'not-repository');
  const rootReal = realpathSync(root);
  const directoryReal = realpathSync(directory);
  if (resolveWithin(rootReal, directoryReal) === null) throw new SnapshotError('Access denied.', 403, 'access-denied');
  const prefix = relative(rootReal, directoryReal).split(sep).join('/');
  const before = capture(directoryReal, rootReal, prefix, selected);
  afterFirstCapture?.();
  const after = capture(directoryReal, rootReal, prefix, selected);
  if (before.key !== after.key) throw new SnapshotError('Changes moved while capturing the diff. Retry.', 409, 'snapshot-stale');
  return { ...stopsFrom(before.parts), signature: before.key };
}

export function registerGitWalkthroughSnapshotRoute(app: Hono): void {
  app.get('/api/git/walkthrough-snapshot', (c) => {
    const directory = c.req.query('directory');
    const scope = c.req.query('scope') ?? 'all';
    if (!directory) return c.json({ error: 'directory parameter is required' }, 400);
    try { return c.json(getWalkthroughSnapshot(directory, undefined, scope as WalkthroughScope)); }
    catch (cause) {
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      return c.json({ error: 'Git snapshot failed.', code: 'git-failed' }, 500);
    }
  });
}

export const __snapshotTestables = { parseStatus, safePath, stopsFrom };
