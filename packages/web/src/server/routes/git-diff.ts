// SPDX-License-Identifier: Apache-2.0
/**
 * P6-2 git read/write routes (doc 03 §5.13/§5.16 subset): per-file diff
 * (patch mode with 3-line default context), image/binary file diff (data
 * URLs), stage/unstage, hunk application (git apply --cached/--reverse),
 * commit, and revert. All routes REQUIRE ?directory and stay within the
 * git repo resolution rules P4-1 established (workspace-bound directory).
 * Exec goes through execFileSync with a 10 s cap; responses are JSON.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { realpath, resolveWithin } from './fs.ts';

function runGit(directory: string, args: string[], input?: string): { ok: true; text: string; buffer?: Buffer } | { ok: false; error: string; code: number | null } {
  try {
    const text = execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    });
    return { ok: true, text };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; message?: string };
    return { ok: false, error: failure.stderr?.trim() || failure.message || 'git failed', code: failure.status ?? null };
  }
}

function runGitBuffer(directory: string, args: string[]): { ok: true; buffer: Buffer } | { ok: false; error: string; code: number | null } {
  try {
    const buffer = execFileSync('git', ['-C', directory, ...args], {
      timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    }) as unknown as Buffer;
    return { ok: true, buffer };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; message?: string };
    return { ok: false, error: failure.stderr?.trim() || failure.message || 'git failed', code: failure.status ?? null };
  }
}

const DIFF_MAX_BYTES = 2_000_000;
const EXEC_TIMEOUT_MS = 10_000;

export function registerGitDiffRoutes(app: Hono): void {
  app.get('/api/git/diff', (c) => diffRoute(c.req.query()));
  app.get('/api/git/file-diff', (c) => fileDiffRoute(c.req.query()));
  app.post('/api/git/stage', (c) => stageRoute(c, 'add'));
  app.post('/api/git/unstage', (c) => stageRoute(c, 'restore'));
  app.post('/api/git/discard', (c) => discardRoute(c));
  app.post('/api/git/apply-hunk', (c) => applyHunkRoute(c));
  app.post('/api/git/commit', (c) => commitRoute(c));
  app.post('/api/git/revert', (c) => discardRoute(c));
}

interface GitQuery { directory?: string; path?: string; staged?: string; contextLines?: string }

function denied(): Response {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}

function notRepo(): Response {
  return Response.json({ isGitRepository: false });
}


function repoRoot(directory: string): string | null {
  const result = runGit(directory, ['rev-parse', '--show-toplevel']);
  if (!result.ok) return null;
  return result.text.trim().length > 0 ? result.text.trim() : null;
}

/** Resolve the requested FILE within the repo root (paths are relative to
 * it); the containment double-hop matches fs routes (§5.14 rules). */
function resolveFileAgainstRepo(directory: string, path: string): string | Response {
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const target = resolve(root, path);
  const within = realpath(target);
  if (root.length > 0 && !within.startsWith(root)) return denied();
  return within;
}

/** git diff for one path; `staged` → --cached (index vs HEAD); the
 * --full-index form is REQUIRED for the §5.10 version-match rule (40/64-hex
 * blob identity; default 7-hex abbreviations can never verify). */
function diffRoute(query: GitQuery): Response {
  const { directory, path, staged, contextLines } = query;
  if (!directory || !path) return Response.json({ error: 'directory and path are required' }, { status: 400 });
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const context = contextNumber(contextLines);
  const args = ['diff', '--no-color', '--full-index', `--unified=${context}`, '--no-renames', '--', path];
  if (staged === 'true') args.splice(1, 0, '--cached');
  const result = runGit(directory, args);
  if (!result.ok && result.code !== 0) return Response.json({ error: result.error }, { status: 500 });
  return Response.json({ diff: result.ok ? result.text : '', path, staged: staged === 'true', contextLines: context });
}

function contextNumber(value: string | undefined): number {
  const parsed = Number(value ?? 3);
  if (!Number.isInteger(parsed) || parsed < 0) return 3;
  return Math.min(parsed, 1_000_000);
}

/** §5.11 image/binary: data-URL style content for the two sides. The file
 * path MUST resolve within the repo root (resolve + realpath double-hop
 * with the fs.ts discipline) — resolve(root, absolutePath) returns the
 * absolute path unchanged, so containment is checked explicitly. */
function fileDiffRoute(query: GitQuery): Response {
  const { directory, path, staged } = query;
  if (!directory || !path) return Response.json({ error: 'directory and path are required' }, { status: 400 });
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const stagedFlag = staged === 'true';
  const originalRef = 'HEAD';

  const isBinaryLike = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|woff2?|ttf|otf|wasm)$/iu.test(path);
  if (!isBinaryLike) return Response.json({ isBinary: false });

  const resolved = resolveWithin(realpath(root), realpath(resolve(root, path)));
  if (resolved === null) return denied();

  const headSide = runGit(directory, ['show', `${originalRef}:${path}`]);
  const workSide = readSide(resolved as string);
  const toDataUrl = (bytes: Buffer | null | undefined): string | null => {
    if (bytes === null) return null;
    const mime = /\.(png)$/iu.test(path) ? 'image/png'
      : /\.(jpe?g)$/iu.test(path) ? 'image/jpeg'
        : /\.(gif)$/iu.test(path) ? 'image/gif'
          : /\.(webp)$/iu.test(path) ? 'image/webp'
            : /\.(pdf)$/iu.test(path) ? 'application/pdf'
              : 'application/octet-stream';
    return `data:${mime};base64,${bytes!.toString('base64')}`;
  };
  const original = headSide.ok ? toDataUrl(headSide.buffer) ?? null : null;
  const modified = workSide === null ? null : toDataUrl(workSide);
  if (original === null && modified === null) {
    return Response.json({ error: 'Content of this file cannot be viewed.', isBinary: true }, { status: 404 });
  }
  return Response.json({ path, staged: stagedFlag, isBinary: true, original, modified });
}

function readSide(target: string): Buffer | null {
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
}

interface StageBody { paths?: string[] }

async function readBody(context: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json() as unknown;
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** git add / git restore --staged for a batch of paths (§6.4 queue target). */
async function stageRoute(context: { req: { json: () => Promise<unknown>; query: () => GitQuery } }, mode: 'add' | 'restore'): Promise<Response> {
  const directory = context.req.query().directory;
  const body = await readBody(context);
  const paths = body?.paths;
  if (!directory || !Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string')) {
    return Response.json({ error: 'directory and paths[] are required' }, { status: 400 });
  }
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const args = mode === 'add'
    ? ['add', '--', ...paths as string[]]
    : ['restore', '--staged', '--', ...paths as string[]];
  const result = runGit(directory, args);
  if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
  return Response.json({ staged: mode === 'add', paths });
}

/** Working-tree revert for paths (§6.3 "Revert changes"): checkout-side. */
async function discardRoute(context: { req: { json: () => Promise<unknown>; query: () => GitQuery } }): Promise<Response> {
  const directory = context.req.query().directory;
  const body = await readBody(context);
  const paths = body?.paths;
  if (!directory || !Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string')) {
    return Response.json({ error: 'directory and paths[] are required' }, { status: 400 });
  }
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const result = runGit(directory, ['checkout', '--', ...paths as string[]]);
  if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
  return Response.json({ discarded: paths });
}

interface HunkBody { path?: string; patch?: string; action?: 'stage' | 'unstage' | 'discard' }

/** §5.6.d apply-hunk: the patch must be exactly ONE 3-line-context hunk
 * (documented server contract); stage/unstage apply to the index,
 * discard applies reverse to the worktree. */
async function applyHunkRoute(context: { req: { json: () => Promise<unknown>; query: () => GitQuery } }): Promise<Response> {
  const directory = context.req.query().directory;
  const body = (await readBody(context)) as HunkBody | null;
  const { path, patch, action } = body ?? {};
  if (!directory || typeof path !== 'string' || typeof patch !== 'string') {
    return Response.json({ error: 'directory, path, patch are required' }, { status: 400 });
  }
  if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
    return Response.json({ error: 'action must be stage|unstage|discard' }, { status: 400 });
  }
  const hunkCount = (patch.match(/^@@ /gmu) ?? []).length;
  if (hunkCount !== 1) {
    return Response.json({ error: 'patch must contain exactly one hunk' }, { status: 400 });
  }
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const args: string[] = ['apply', '--whitespace=nowarn'];
  if (action === 'stage') args.push('--cached');
  if (action === 'unstage') args.push('--cached', '--reverse');
  if (action === 'discard') args.push('--reverse');
  args.push('-');
  const result = runGit(directory, args, patch);
  if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
  return Response.json({ applied: action, path });
}

interface CommitBody { message?: string }

async function commitRoute(context: { req: { json: () => Promise<unknown>; query: () => GitQuery } }): Promise<Response> {
  const directory = context.req.query().directory;
  const body = (await readBody(context)) as CommitBody | null;
  const message = body?.message;
  if (!directory || typeof message !== 'string' || message.trim().length === 0) {
    return Response.json({ error: 'directory and message are required' }, { status: 400 });
  }
  const root = repoRoot(directory);
  if (root === null) return notRepo();
  const result = runGit(directory, ['commit', '-m', message]);
  if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
  const hash = runGit(directory, ['rev-parse', 'HEAD']);
  return Response.json({
    committed: true,
    hash: hash.ok ? hash.text.trim() : null,
  });
}
