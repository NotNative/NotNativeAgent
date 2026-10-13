// SPDX-License-Identifier: Apache-2.0
/**
 * Walkthrough source descriptor and bounded comparison snapshot (doc 13 §F.1).
 * Git-backed descriptors compare by full object IDs and stable patch hashes.
 * PR descriptors are available for supported UI selection but fail closed when
 * GitHub transport is unavailable, rather than producing an empty walkthrough.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import { realpath, resolveWithin } from './fs.ts';
import {
  OWNER, REPOSITORY, parseWalkthroughSource, sourceKey,
  type WalkthroughScope, type WalkthroughSource,
} from './git-walkthrough-sources.ts';

export const SNAPSHOT_MAX_FILES = 60;
export const SNAPSHOT_MAX_HUNKS = 200;
export const SNAPSHOT_MAX_PATCH_BYTES = 750_000;
const TIMEOUT_MS = 10_000;
const MAX_REF_CHARS = 256;
const DIFF_PART_COUNT = 128;
type Scope = 'staged' | 'working';
type Entry = { path: string; oldPath?: string; index: string; working: string };
type Part = { scope: Scope; path: string; oldPath?: string; patch: string };
type Stop = { id: string; scope: Scope; path: string; oldPath?: string; header: string; oldStart: number; newStart: number; body: string };
export type Snapshot = { signature: string; stops: Stop[]; fileCount: number; binaryFiles: number; source?: WalkthroughSource };

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
    entries.push({ path, ...(oldPath ? { oldPath: oldPath } : {}), index, working });
  }
  return entries;
}

function safePath(root: string, directory: string, path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const candidate = resolve(root, path);
  const workspace = realpath(directory);
  if (resolveWithin(workspace, candidate) === null) return false;
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
  parts.sort((a, b) => a.path.localeCompare(b.path));
  const head = safeHead(root);
  const key = createHash('sha1').update([head, selected, ...parts.map((part) => [part.scope, part.path, part.patch].join('\0'))].join('\0')).digest('hex');
  return { key, parts };
}

function safeHead(root: string): string {
  try {
    const branch = git(root, ['symbolic-ref', '--quiet', 'HEAD'], 4096).trim();
    if (branch) return branch;
  } catch {
  }
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], 4096).trim();
  } catch {
    return '';
  }
}

function diffPart(root: string, entry: Entry, scope: Scope): Part {
  let patch: string;
  if (entry.index === '?') {
    const path = resolve(root, entry.path);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotError('Untracked file is not a regular file.', 413, 'unsupported-untracked');
    if (info.size > SNAPSHOT_MAX_PATCH_BYTES) throw new SnapshotError('Diff exceeds walkthrough preview limit.', 413, 'diff-too-large');
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

export function sourceRoot(directory: string): string {
  const root = git(directory, ['rev-parse', '--show-toplevel'], 4096).trim();
  if (!root || !isAbsolute(root)) throw new SnapshotError('No Git repository is available.', 404, 'not-repository');
  const rootReal = realpathSync(root);
  const directoryReal = realpathSync(directory);
  if (resolveWithin(rootReal, directoryReal) === null) throw new SnapshotError('Access denied.', 403, 'access-denied');
  return rootReal;
}

function reviewObject(root: string, ref: string, label: string): string {
  if (!ref || Buffer.byteLength(ref, 'utf8') > MAX_REF_CHARS) throw new SnapshotError(`Invalid ${label} reference.`, 400, 'invalid-source');
  let value = '';
  try {
    value = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 4096).trim();
  } catch (cause) {
    if (cause instanceof SnapshotError && cause.code === 'git-failed') throw new SnapshotError(`Unknown ${label} reference.`, 404, 'unknown-source');
    throw cause;
  }
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new SnapshotError(`Unknown ${label} reference.`, 404, 'unknown-source');
  return value;
}

function loadGitHubPullRequest(): string {
  throw new SnapshotError('GitHub is not connected.', 401, 'github-not-connected');
}

function patchDiff(root: string, args: string[]): string {
  return git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index', '--unified=3', '--find-renames', ...args]);
}

function loadSourcePatch(root: string, source: WalkthroughSource): string {
  if (source.kind === 'branch') {
    const base = reviewObject(root, source.baseRef, 'base');
    const head = reviewObject(root, source.headRef, 'head');
    const mergeBase = git(root, ['merge-base', base, head], 4096).trim();
    if (!/^[0-9a-f]{40}$/u.test(mergeBase)) throw new SnapshotError('Branch comparison bases do not share history.', 404, 'unknown-source');
    return patchDiff(root, [`${mergeBase}..${head}`]);
  }
  if (source.kind === 'commit') {
    const hash = reviewObject(root, source.hash, 'commit');
    return git(root, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index',
      '--unified=3', '--find-renames', hash, '--', '.'], SNAPSHOT_MAX_PATCH_BYTES + 65_536);
  }
  if (source.kind === 'pr') return loadGitHubPullRequest();
  return patchDiff(root, ['--', '.']);
}

function getWalkthroughSourceSnapshot(directory: string, source: WalkthroughSource, afterFirstCapture?: () => void): Snapshot {
  const root = sourceRoot(directory);
  const before = loadSourcePatch(root, source);
  afterFirstCapture?.();
  const after = loadSourcePatch(root, source);
  if (before !== after) throw new SnapshotError('Changes moved while capturing the diff. Retry.', 409, 'snapshot-stale');
  const revision = `${sourceKey(source)}:${createHash('sha1').update(before).digest('hex')}`;
  return { ...stopsFrom(sourceParts(before)), signature: revision, source };
}

function sourceParts(patch: string): Part[] {
  return patch.split(/^diff --git /mu).filter(Boolean).slice(0, DIFF_PART_COUNT).map((body) => {
    const header = body.split('\n', 1)[0] ?? '';
    const [left, right] = header.split(/\s+b\//u, 2);
    return { scope: 'working' as const, path: right ?? 'unknown', patch: body };
  });
}

export function getWalkthroughSnapshot(directory: string, afterFirstCapture?: () => void,
  selected: WalkthroughSource | WalkthroughScope = 'all'): Snapshot & { source?: WalkthroughSource } {
if (typeof selected === 'string' && !['all', 'staged', 'working'].includes(selected)) {
  throw new SnapshotError('Invalid walkthrough scope.', 400, 'invalid-scope');
}
const source = typeof selected === 'string' ? parseWalkthroughSource(selected) : selected;
  return source.kind === 'working-tree'
    ? getWalkthroughScopeSnapshot(directory, source.scope, afterFirstCapture)
    : getWalkthroughSourceSnapshot(directory, source, afterFirstCapture);
}

function getWalkthroughScopeSnapshot(directory: string, selected: WalkthroughScope, afterFirstCapture?: () => void): Snapshot {
  const root = sourceRoot(directory);
  const rootReal = realpathSync(root);
  const directoryReal = realpathSync(directory);
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
    if (!directory) return c.json({ error: 'directory parameter is required' }, 400);
    const encodedSource = c.req.query('source');
    const scope = c.req.query('scope') ?? 'all';
    try {
      let rawSource: WalkthroughSource = parseWalkthroughSource(scope);
      if (encodedSource) {
        if (Buffer.byteLength(encodedSource, 'utf8') > 4_096) throw new SnapshotError('Walkthrough source is too large.', 413, 'source-too-large');
        rawSource = parseWalkthroughSource(JSON.parse(encodedSource));
      }
      const source = rawSource as WalkthroughSource;
      const snapshot = source.kind === 'working-tree'
        ? getWalkthroughSnapshot(directory, undefined, source.scope)
        : getWalkthroughSourceSnapshot(directory, source);
      return c.json(snapshot);
    } catch (cause) {
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      const admission = cause as { status?: unknown; code?: unknown };
      if (typeof admission.status === 'number') {
        return c.json({ error: cause instanceof Error ? cause.message : 'Invalid walkthrough source.', code: String(admission.code) }, admission.status as 400);
      }
      return c.json({ error: 'Git snapshot failed.', code: 'git-failed' }, 500);
    }
  });
}

export const __snapshotTestables = { parseStatus, safePath, stopsFrom, OWNER, REPOSITORY };
