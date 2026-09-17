// SPDX-License-Identifier: Apache-2.0
/**
 * P4-1 filesystem routes (doc 03 Â§5.14 subset): list/search/git-dirs with
 * WORKSPACE-BOUND containment (mode 1 of two authorization modes). Target
 * paths must resolve inside the `directory` scope; symlink escapes map to
 * 403 'Access denied'. Responses echo the CALLER's path space.
 */
import { readdirSync, lstatSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join as joinPath, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { Hono } from 'hono';

const GIT_DIRS_MAX_DEPTH = 3;
const GIT_DIRS_MAX_DIRS = 100;
const SKIP_LIST = new Set(['node_modules', 'dist', 'build', '.venv', 'target', '.next']);
const SEARCH_LIMIT_DEFAULT = 40;

export function registerFsRoutes(app: Hono): void {
  app.get('/api/fs/list', (c) => listDirectory(c.req.query()));
  app.get('/api/fs/search', (c) => searchFiles(c.req.query()));
  app.get('/api/fs/git-dirs', (c) => gitDirs(c.req.query()));
}

interface QueryBag { path?: string; directory?: string; query?: string; limit?: string; respectGitignore?: string }

function fail(c: { json: (body: unknown, status?: number) => Response }, status: number, error: string, reason?: string): Response {
  return reason ? c.json({ error, reason }, status) : c.json({ error }, status);
}

/** Resolve a requested path against the workspace scope. CONTAINMENT IS
 * DEVICE-AWARE (P0-1): on Windows `relative()` returns an ABSOLUTE string for
 * cross-drive targets (accepted blind otherwise). `..bar` is a legal in-scope
 * filename â€” only exact `..` and `../` prefixes are traversal. */
export function resolveWithin(scopeDir: string, requested: string): string | null {
  const scopeRoot = resolve(scopeDir);
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(scopeRoot, requested);
  if (parse(candidate).root.toUpperCase() !== parse(scopeRoot).root.toUpperCase()) return null;
  const rel = relative(scopeRoot, candidate);
  if (rel === '') return candidate; // the scope root itself
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
  if (isAbsolute(rel)) return null;
  return candidate;
}

function realpath(pathValue: string): string {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function containedAfterRealpath(scopeDir: string, candidate: string): boolean {
  return resolveWithin(realpath(scopeDir), candidate) !== null;
}

/** Â§5.14 fs/list (P0-2 hardening): the TARGET must be realpath-contained in
 * the scope realpath BEFORE any stat/readdir â€” a junction/symlink that escapes
 * the workspace maps to 403. Entry booleans report the lstat (link) plus the
 * target stat; links whose target escapes are listed but marked with
 * booleans false so UI treaters never dereference them (registered delta). */
function listDirectory(query: QueryBag): Response {
  const scopeDir = query.directory;
  if (!scopeDir) return missingDirectoryResponse();
  const requested = query.path ? query.path : '.';
  const within = resolveWithin(scopeDir, requested);
  if (!within) return deniedResponse();
  const scopeReal = realpath(scopeDir);
  const realTarget = realpath(within);
  if (!containedAfterRealpath(scopeDir, realTarget)) return deniedResponse();
  let stat;
  try { stat = statSync(realTarget); } catch (error) {
    return osPermissionOrGeneric(error);
  }
  if (!stat.isDirectory()) {
    return Response.json({ error: 'Not a directory', reason: 'not-directory' }, { status: 400 });
  }
  try {
    const names = readdirSync(realTarget);
    const entries = names.map((name) => {
      const childPath = joinChild(realTarget, name);
      let isDirectory = false;
      let isFile = false;
      let isSymbolicLink = false;
      let linkContained = false;
      try {
        const linkStat = lstatSync(childPath, { throwIfNoEntry: false });
        isSymbolicLink = Boolean(linkStat?.isSymbolicLink());
        const targetStat = statSync(childPath, { throwIfNoEntry: false });
        isDirectory = Boolean(targetStat?.isDirectory());
        isFile = Boolean(targetStat?.isFile());
        if (isSymbolicLink) {
          linkContained = containedAfterRealpath(scopeReal, realpath(childPath));
          if (!linkContained) { isDirectory = false; isFile = false; }
        }
      } catch {
        /* stat failure keeps the entry with booleans false */
      }
      return { name, path: childPath, isDirectory, isFile, isSymbolicLink, contained: !isSymbolicLink || linkContained };
    });
    return Response.json({ path: within, entries });
  } catch (error) {
    return osPermissionOrGeneric(error);
  }
}

function joinChild(base: string, name: string): string {
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

/** NND-extended server-side picker search (Â§D delta): bounded walk with the
 * skip list + `.git` boundary (P1 review fix â€” .git internals never surface),
 * SYMBOLIC-LINK DESCENT SKIPPED unless the target realpath stays in scope,
 * filename filter, limit capped at 200. */
function searchFiles(query: QueryBag): Response {
  const scopeDir = query.directory;
  if (!scopeDir) return missingDirectoryResponse();
  const needle = (query.query ?? '').toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? SEARCH_LIMIT_DEFAULT) || SEARCH_LIMIT_DEFAULT));
  const scopeReal = realpath(scopeDir);
  const rootReal = realpath(resolve(scopeDir, '.'));
  if (!containedAfterRealpath(scopeReal, rootReal)) return deniedResponse();
  if (!existsSync(rootReal)) return notFoundResponse();
  const results: { path: string; name: string; isDirectory: boolean }[] = [];
  const walk = (dir: string, depth: number, visited: number): number => {
    if (depth > GIT_DIRS_MAX_DEPTH || visited > GIT_DIRS_MAX_DIRS || results.length >= limit) return visited;
    let entries;
    try { entries = readdirSync(dir); } catch { return visited + 1; }
    for (const name of entries) {
      if (SKIP_LIST.has(name) || name === '.git') continue;
      const child = joinChild(dir, name);
      const relativePath = relative(rootReal, child).split(sep).join('/');
      let childStat;
      try { childStat = lstatSync(child, { throwIfNoEntry: false }); } catch { continue; }
      if (!childStat) continue;
      let descend = childStat.isDirectory();
      const isLink = childStat.isSymbolicLink();
      if (isLink) {
        try {
          descend = containedAfterRealpath(scopeReal, realpath(child))
            && statSync(child, { throwIfNoEntry: false })?.isDirectory() === true;
        } catch { descend = false; }
      }
      const lower = name.toLowerCase();
      const matches = needle.length === 0 || lower.includes(needle) || relativePath.toLowerCase().includes(needle);
      if (childStat.isFile() && matches) results.push({ path: relativePath, name, isDirectory: false });
      if (descend) {
        visited = walk(child, depth + 1, visited);
        if (results.length >= limit) return visited;
      }
      if (visited > GIT_DIRS_MAX_DIRS) return visited;
    }
    return visited;
  };
  walk(rootReal, 0, 0);
  return Response.json({ path: rootReal, query: needle, entries: results.slice(0, limit) });
}

/** Â§5.14 git-dirs (P1 fix): REQUIRED `directory` scope; the walk is realpath-
 * contained; root itself is NOT listed even when it holds `.git`. */
function gitDirs(query: QueryBag): Response {
  const scopeDir = query.directory;
  if (!scopeDir) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
  const within = resolveWithin(scopeDir, '.');
  if (!within) return deniedResponse();
  const scopeReal = realpath(scopeDir);
  const rootReal = realpath(within);
  if (!containedAfterRealpath(scopeReal, rootReal)) return deniedResponse();
  if (!existsSync(rootReal)) return notFoundResponse();
  const found: { path: string; name: string }[] = [];
  const walk = (dir: string, depth: number, visited: number): number => {
    if (depth > GIT_DIRS_MAX_DEPTH || visited > GIT_DIRS_MAX_DIRS) return visited;
    visited += 1;
    let entries;
    try { entries = readdirSync(dir); } catch { return visited; }
    const isRoot = dir === rootReal;
    if (entries.includes('.git') && !isRoot) {
      found.push({ path: relative(scopeReal, dir).split(sep).join('/'), name: dir.split(sep).pop() ?? dir });
      return visited; // repo boundary stops descent
    }
    for (const name of entries) {
      if (SKIP_LIST.has(name) || name === '.git') continue;
      const child = joinChild(dir, name);
      let childStat;
      try { childStat = lstatSync(child, { throwIfNoEntry: false }); } catch { continue; }
      let descend = Boolean(childStat?.isDirectory());
      if (childStat?.isSymbolicLink()) {
        try { descend = containedAfterRealpath(scopeReal, realpath(child)); } catch { descend = false; }
      }
      if (descend) visited = walk(child, depth + 1, visited);
    }
    return visited;
  };
  walk(rootReal, 0, 0);
  return Response.json({ path: rootReal, repositories: found });
}

function missingDirectoryResponse(): Response {
  return Response.json({ error: 'directory parameter is required' }, { status: 400 });
}
function deniedResponse(): Response {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}
function notFoundResponse(): Response {
  return Response.json({ error: 'Directory not found', reason: 'not-found' }, { status: 404 });
}
function osPermissionOrGeneric(error: unknown): Response {
  const code = (error as { code?: string }).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return Response.json({ error: 'Permission denied', reason: 'os-permission' }, { status: 403 });
  }
  if ((error as { code?: string }).code === 'ENOENT') {
    return Response.json({ error: 'Directory not found', reason: 'not-found' }, { status: 404 });
  }
  return Response.json({ error: 'fs operation failed' }, { status: 500 });
}
