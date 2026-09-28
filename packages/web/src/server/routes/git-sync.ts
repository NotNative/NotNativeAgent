// SPDX-License-Identifier: Apache-2.0
/** Explicit branch sync for the Changes surface. Never runs on a status poll. */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Hono } from 'hono';

const execute = promisify(execFile);
const SYNC_TIMEOUT_MS = 60_000;
const activeRoots = new Set<string>();

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, maxBuffer: 2_000_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

function failure(error: unknown): string {
  const issue = error as { stderr?: string; message?: string };
  return issue.stderr?.trim() || issue.message || 'Git operation failed';
}

function conflict(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

async function stillOnBranch(root: string, branch: string): Promise<boolean> {
  return await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '') === branch;
}

async function upstreamConfig(root: string, branch: string): Promise<{ remote: string; mergeRef: string } | Response> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '');
  if (!upstream) return conflict('Configure an upstream branch before syncing');
  const remote = await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
  if (!remote || remote.startsWith('-')) return conflict('The branch has no usable upstream remote');
  const mergeRef = await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
  if (!mergeRef.startsWith('refs/heads/') || mergeRef === 'refs/heads/') {
    return conflict('The branch has no usable upstream branch');
  }
  return { remote, mergeRef };
}

export function registerGitSyncRoutes(app: Hono): void {
  app.post('/api/git/sync', async (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    let root: string;
    try { root = await git(directory, ['rev-parse', '--show-toplevel']); }
    catch { return Response.json({ isGitRepository: false, error: 'Not a Git repository' }, { status: 400 }); }
    // A junction, symlink, or differently-cased Windows path must not bypass
    // the per-repository guard while a fetch/rebase/push is in flight.
    const lockKey = process.platform === 'win32' ? (await realpath(root)).toLowerCase() : await realpath(root);
    if (activeRoots.has(lockKey)) return conflict('A sync is already running for this repository');
    activeRoots.add(lockKey);
    try {
      const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
      if (!branch) return conflict('Check out a branch before syncing');
      const upstream = await upstreamConfig(root, branch);
      if (upstream instanceof Response) return upstream;
      const { remote, mergeRef } = upstream;
      if (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
        return conflict('Commit or stash all changes before syncing');
      }
      try { await git(root, ['fetch', '--no-tags', '--', remote]); }
      catch (error) { return Response.json({ error: `Fetch failed: ${failure(error)}` }, { status: 502 }); }
      if (!await stillOnBranch(root, branch)) return conflict('The current branch changed during sync; retry on the intended branch');
      const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      const [ahead, behind] = counts.split(/\s+/u).map(Number);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
        return Response.json({ error: 'Could not determine upstream divergence' }, { status: 500 });
      }
      if (behind! > 0) {
        if (!await stillOnBranch(root, branch)) return conflict('The current branch changed during sync; retry on the intended branch');
        try { await git(root, ['rebase', '@{upstream}']); }
        catch (error) {
          return conflict(`Rebase needs attention: ${failure(error)}. Resolve or abort the rebase before syncing again.`);
        }
      }
      const remaining = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      const toPush = Number(remaining.split(/\s+/u)[0]);
      if (!Number.isSafeInteger(toPush)) return Response.json({ error: 'Could not determine commits to push' }, { status: 500 });
      if (!await stillOnBranch(root, branch)) return conflict('The current branch changed during sync; retry on the intended branch');
      if (toPush > 0) {
        // Pin the selected branch's commit before invoking push: an external
        // branch switch cannot redirect HEAD into this upstream.
        // Also suppress configured tag/submodule pushes, not just push.default.
        const branchCommit = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
        try { await git(root, ['push', '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${branchCommit}:${mergeRef}`]); }
        catch (error) { return Response.json({ error: `Push failed: ${failure(error)}` }, { status: 502 }); }
      }
      return Response.json({ synced: true, branch, pulled: behind! > 0, pushed: toPush > 0 });
    } catch (error) {
      return Response.json({ error: failure(error) }, { status: 500 });
    } finally {
      activeRoots.delete(lockKey);
    }
  });
}
