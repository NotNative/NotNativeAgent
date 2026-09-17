// SPDX-License-Identifier: Apache-2.0
/**
 * P4-1 git routes (doc 03 §5.13 subset): check (#7) + status (#12) — the
 * §5.13 contract verbatim: `?directory` REQUIRED (400 otherwise); non-repo
 * paths answer a PAYLOAD (`isGitRepository:false`) instead of failing; git
 * stderr rides `error` on real failures (500). Light mode trims files to
 * paths + staged flags (review surfaces get the full set in P4-2).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';

const GIT_TIMEOUT_MS = 10_000;

export interface GitStatusEntry { path: string; staged: boolean; xy?: string }
export interface GitStatusPayload {
  isGitRepository: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusEntry[];
  merge?: { state: string } | null;
  rebase?: { state: string } | null;
}

export function registerGitRoutes(app: Hono): void {
  app.get('/api/git/check', (c) => {
    const directory = c.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    return Response.json({ isGitRepository: isGitRepository(directory) });
  });
  app.get('/api/git/status', (c) => {
    const directory = c.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    const mode = c.req.query('mode') ?? 'full';
    const status = gitStatus(directory, mode === 'light');
    if (typeof status === 'string') return Response.json({ error: status }, { status: 500 });
    return Response.json(status);
  });
}

function isGitRepository(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const gitDir = git(['rev-parse', '--is-inside-work-tree'], directory);
  return gitDir.status === 0 && gitDir.stdout.trim() === 'true';
}

/** Returns GitStatusPayload, or a 500 error STRING when git failed. */
function gitStatus(directory: string, light: boolean): GitStatusPayload | string {
  if (!isGitRepository(directory)) {
    return { isGitRepository: false, branch: null, ahead: 0, behind: 0, files: [] };
  }
  const porcelain = git(['status', '--porcelain=v1', '-b'], directory);
  if (porcelain.status !== 0) {
    return `${porcelain.stderr || 'git status failed'}`.trim();
  }
  return parsePorcelain(porcelain.stdout, light);
}

function parsePorcelain(stdout: string, light: boolean): GitStatusPayload {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const unborn = /^No commits yet on (.+)$/u.exec(head);
      if (unborn) {
        branch = unborn[1]!; // §5.13 #12: an unborn branch still HAS a name
      } else {
        const trackingMatch = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/u.exec(head);
        if (trackingMatch) {
          ahead = Number(trackingMatch[1] ?? 0) || 0;
          behind = Number(trackingMatch[2] ?? 0) || 0;
          branch = head.slice(0, trackingMatch.index).trim().replace(/\.\.\.$/u, '') || null;
        } else {
          branch = head.includes('...') ? head.split('...')[0]!.trim() : head.trim() || null;
        }
      }
      if (branch === 'HEAD') branch = 'HEAD'; // detached: surfaced as HEAD by design
      continue;
    }
    const xy = line.slice(0, 2);
    const before = line.slice(3);
    // renames arrive as `old -> new` in porcelain v1 paths
    const renamed = / -> /u.test(before);
    const path = renamed ? before : before;
    files.push(light ? { path, staged: xy[0] !== ' ' && xy[0] !== '?' } : { path, staged: xy[0] !== ' ' && xy[0] !== '?', xy });
  }
  return { isGitRepository: true, branch, ahead, behind, files };
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

export const __gitTestables = { parsePorcelain, isGitRepository };
