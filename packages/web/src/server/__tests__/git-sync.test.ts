// SPDX-License-Identifier: Apache-2.0
/** Sync contract against isolated local Git remotes; never contacts a network. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerGitSyncRoutes } from '../routes/git-sync.ts';

let sandbox: string | null = null;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(withRemote = true): { local: string; remote: string; peer: string } {
  sandbox = mkdtempSync(join(tmpdir(), 'nnd-git-sync-'));
  const local = join(sandbox, 'local');
  const remote = join(sandbox, 'remote.git');
  const peer = join(sandbox, 'peer');
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  git(local, 'config', 'user.name', 'NND Test');
  git(local, 'config', 'user.email', 'nnd@example.test');
  writeFileSync(join(local, 'base.txt'), 'base\n');
  git(local, 'add', '-A');
  git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  if (withRemote) {
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(local, 'remote', 'add', 'origin', remote);
    git(local, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    execFileSync('git', ['clone', '-q', remote, peer]);
    git(peer, 'config', 'user.name', 'NND Peer');
    git(peer, 'config', 'user.email', 'peer@example.test');
  }
  return { local, remote, peer };
}

async function sync(directory?: string): Promise<Response> {
  const app = new Hono();
  registerGitSyncRoutes(app);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return app.request(`http://localhost/api/git/sync${query}`, { method: 'POST' });
}

describe('explicit Git sync', () => {
  it('requires a directory, a repository, and an upstream without mutating local commits', async () => {
    expect((await sync()).status).toBe(400);
    const { local } = fixture(false);
    const before = git(local, 'rev-parse', 'HEAD');
    const response = await sync(local);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('upstream');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('pushes local commits to the configured upstream', async () => {
    const { local, remote } = fixture();
    writeFileSync(join(local, 'local.txt'), 'local\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'local');
    const response = await sync(local);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synced: true, pulled: false, pushed: true });
    expect(git(remote, 'rev-parse', 'main')).toBe(git(local, 'rev-parse', 'HEAD'));
  });

  it('pushes only the current upstream even when push.default matches every branch', async () => {
    const { local, remote } = fixture();
    git(local, 'branch', 'side');
    git(local, 'push', '-q', 'origin', 'side');
    const originalSide = git(remote, 'rev-parse', 'side');
    git(local, 'switch', '-q', 'side');
    writeFileSync(join(local, 'side.txt'), 'side\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'side local only');
    git(local, 'switch', '-q', 'main');
    git(local, 'config', 'push.default', 'matching');
    writeFileSync(join(local, 'main.txt'), 'main\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'main local');
    expect((await sync(local)).status).toBe(200);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(git(remote, 'rev-parse', 'side')).toBe(originalSide);
  });

  it('does not push annotated tags even when push.followTags is configured', async () => {
    const { local, remote } = fixture();
    writeFileSync(join(local, 'next.txt'), 'next\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'next');
    git(local, '-c', 'tag.gpgsign=false', 'tag', '-a', 'v-test', '-m', 'local tag');
    git(local, 'config', 'push.followTags', 'true');
    const response = await sync(local);
    expect(response.status).toBe(200);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(git(remote, 'tag', '--list')).toBe('');
  });

  it('fetches, rebases divergent clean commits, and pushes the result', async () => {
    const { local, remote, peer } = fixture();
    writeFileSync(join(local, 'local.txt'), 'local\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'local');
    writeFileSync(join(peer, 'peer.txt'), 'peer\n');
    git(peer, 'add', '-A');
    git(peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'peer');
    git(peer, 'push', '-q');
    const response = await sync(local);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synced: true, pulled: true, pushed: true });
    expect(git(remote, 'rev-parse', 'main')).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(git(local, 'log', '--format=%s', '-2')).toContain('peer');
  });

  it('refuses a dirty worktree before fetching or rebasing', async () => {
    const { local } = fixture();
    writeFileSync(join(local, 'untracked.txt'), 'keep\n');
    const before = git(local, 'rev-parse', 'HEAD');
    const response = await sync(local);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('Commit or stash');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
  });
});
