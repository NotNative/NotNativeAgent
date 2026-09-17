// SPDX-License-Identifier: Apache-2.0
/**
 * P4-1 git routes (doc 03 section 5.13 subset): check (#7) + status (#12) —
 * the 5.13 contract verbatim: `?directory` REQUIRED (400 otherwise); non-repo
 * paths answer a PAYLOAD (`isGitRepository:false`) instead of failing; git
 * stderr rides `error` on real failures (500). Light mode still emits
 * index/working_dir codes so the review surfaces (doc 06) can derive
 * staged/working without a second round-trip. Branches/log live with the
 * P4-2 read family (projects.ts registerGitReadRoutes).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';

const GIT_TIMEOUT_MS = 10_000;

export interface GitStatusEntry { path: string; index: string; working_dir: string; staged?: boolean }
export interface GitStatusPayload {
  isGitRepository: boolean;
  branch: string | null;
  trackingAhead: number;
  trackingBehind: number;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  files: GitStatusEntry[];
}

export function registerGitRoutes(app: Hono): void {
  app.get('/api/git/check', (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    return Response.json({ isGitRepository: isGitRepository(directory) });
  });
  app.get('/api/git/status', (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    const mode = context.req.query('mode') ?? 'full';
    const status = gitStatus(directory, mode === 'light');
    if (typeof status === 'string') return Response.json({ error: status }, { status: 500 });
    return Response.json(status);
  });
}

export function isGitRepository(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const gitDir = git(['rev-parse', '--is-inside-work-tree'], directory);
  return gitDir.status === 0 && gitDir.stdout.trim() === 'true';
}

function gitStatus(directory: string, light: boolean): GitStatusPayload | string {
  if (!isGitRepository(directory)) {
    return { isGitRepository: false, branch: null, trackingAhead: 0, trackingBehind: 0, mergeInProgress: false, rebaseInProgress: false, files: [] };
  }
  const porcelain = git(['status', '--porcelain=v1', '-z', '-b'], directory);
  if (porcelain.status !== 0) {
    return `${porcelain.stderr || 'git status failed'}`.trim();
  }
  return parsePorcelain(porcelain.stdout, light);
}

export function parsePorcelain(stdout: string, light: boolean): GitStatusPayload {
  // -z keeps NUL-terminated entries: `XY <path>\0[path\0]` (renames doubled)
  const records = stdout.split('\0').filter((record) => record.length > 0);
  let branch: string | null = null;
  let trackingAhead = 0;
  let trackingBehind = 0;
  const files: GitStatusEntry[] = [];
  const emit = (xy: string, path: string): void => {
    const indexChar = xy.charCodeAt(0) === 0x3F /* ? */ ? ' ' : (xy[0] ?? '?');
    const workChar = xy.charCodeAt(1) === 0x3F || xy.charCodeAt(1) === 0x20 ? ' ' : (xy[1] ?? ' ');
    files.push({ path, index: indexChar, working_dir: workChar, staged: xy[0] !== ' ' && xy[0] !== '?' });
  };
  for (const record of records) {
    if (record.startsWith('## ')) {
      const head = record.slice(3);
      const trackingMatch = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/u.exec(head);
      if (trackingMatch) {
        trackingAhead = Number(trackingMatch[1] ?? 0) || 0;
        trackingBehind = Number(trackingMatch[2] ?? 0) || 0;
        branch = head.slice(0, trackingMatch.index).trim().replace(/\.\.\.$/u, '') || null;
      } else {
        branch = head.includes('...') ? head.split('...')[0]!.trim() : head.trim() || null;
      }
      if (branch === 'HEAD') branch = 'HEAD';
      continue;
    }
    if (record.length <= 3) continue;
    const xy = record.slice(0, 2);
    const pathPart = record.slice(3);
    const renameParts = pathPart.split(' -> ');
    const path = renameParts[renameParts.length - 1] ?? pathPart;
    emit(xy, path);
  }
  return { isGitRepository: true, branch, trackingAhead, trackingBehind, mergeInProgress: false, rebaseInProgress: false, files };
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
