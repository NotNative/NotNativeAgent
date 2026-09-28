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

type UpstreamConfig = { remote: string; mergeRef: string; firstPush: boolean };

async function upstreamConfig(root: string, branch: string): Promise<UpstreamConfig | Response> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '');
  if (!upstream) {
    const remotes = (await git(root, ['remote'])).split(/\r?\n/u).filter(Boolean);
    if (remotes.length === 0) return conflict('Add a Git remote before syncing');
    const configuredMerge = await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
    if (configuredMerge) return conflict('The branch has a configured but unavailable upstream; repair its tracking configuration before syncing');
    const branchPushRemote = await git(root, ['config', '--get', `branch.${branch}.pushRemote`]).catch(() => '');
    const defaultPushRemote = await git(root, ['config', '--get', 'remote.pushDefault']).catch(() => '');
    const branchRemote = await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
    const remote = branchPushRemote || defaultPushRemote || branchRemote || (remotes.length === 1 ? remotes[0]! : '');
    if (!remote) return conflict('Choose an upstream remote before syncing');
    if (!remotes.includes(remote)) return conflict(`Configured push remote ${remote} is unavailable`);
    return { remote, mergeRef: `refs/heads/${branch}`, firstPush: true };
  }
  const remote = await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
  if (!remote || remote.startsWith('-')) return conflict('The branch has no usable upstream remote');
  const mergeRef = await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
  if (!mergeRef.startsWith('refs/heads/') || mergeRef === 'refs/heads/') {
    return conflict('The branch has no usable upstream branch');
  }
  return { remote, mergeRef, firstPush: false };
}

async function firstPush(root: string, branch: string, remote: string, mergeRef: string): Promise<Response> {
  // A branch with no upstream may be new, or may be an existing remote branch
  // with unrelated history. Never silently adopt or overwrite the latter.
  try {
    await git(root, ['ls-remote', '--exit-code', '--heads', '--', remote, mergeRef]);
    return conflict('A remote branch with this name already exists; configure its upstream before syncing');
  } catch (error) {
    if ((error as { code?: number }).code !== 2) {
      return Response.json({ error: `Remote branch check failed: ${failure(error)}` }, { status: 502 });
    }
  }
  if (!await stillOnBranch(root, branch)) return conflict('The current branch changed during sync; retry on the intended branch');
  // A concurrent agent can advance the local branch after the clean-worktree
  // check. Push exactly the commit we inspected, not a moving branch ref.
  const branchCommit = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  try {
    // The branch may be created between ls-remote and push. The empty lease
    // requires it to remain absent, even if our commit could fast-forward it.
    await git(root, ['push', `--force-with-lease=${mergeRef}:`, '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${branchCommit}:${mergeRef}`]);
  } catch (error) { return Response.json({ error: `Push failed: ${failure(error)}` }, { status: 502 }); }
  try { await git(root, ['branch', `--set-upstream-to=${remote}/${branch}`, branch]); }
  catch (error) {
    return Response.json({ error: `Push succeeded, but branch tracking setup failed: ${failure(error)}` }, { status: 502 });
  }
  const currentCommit = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => '');
  if (currentCommit !== branchCommit) {
    return conflict('The branch changed while publishing. The inspected commit was pushed; sync again to publish newer local commits');
  }
  return Response.json({ synced: true, branch, pulled: false, pushed: true, createdUpstream: true });
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
      if (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
        return conflict('Commit or stash all changes before syncing');
      }
      const upstream = await upstreamConfig(root, branch);
      if (upstream instanceof Response) return upstream;
      const { remote, mergeRef } = upstream;
      if (upstream.firstPush) return await firstPush(root, branch, remote, mergeRef);
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
