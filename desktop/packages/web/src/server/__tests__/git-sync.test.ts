// SPDX-License-Identifier: Apache-2.0
/** Sync contract against isolated local Git remotes; never contacts a network. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerGitSyncRoutes } from '../routes/git-sync.ts';
import { buildSyncTemplate, copySyncFixture, git, type SyncTemplate } from './helpers/git-fixture-kit.ts';

let sandbox: string | null = null;

// Template repo built once per file; each test gets an isolated copy.
const template: SyncTemplate = buildSyncTemplate();

function fixture(withRemote = true): { local: string; remote: string; peer: string; root: string } {
  const copied = copySyncFixture(template);
  if (!withRemote) {
    // Remote-less scenarios never touch origin; drop the copied remote and
    // clear the configured remote so state matches the old local-only fixture.
    execFileSync('git', ['-C', copied.local, 'remote', 'remove', 'origin'], { windowsHide: true });
  }
  return { local: copied.local, remote: copied.remote, peer: copied.peer, root: copied.root };
}

async function sync(directory?: string): Promise<Response> {
  const app = new Hono();
  registerGitSyncRoutes(app);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return app.request(`http://localhost/api/git/sync${query}`, { method: 'POST' });
}

async function checkout(directory: string, branch: string, expectedBranch = 'main'): Promise<Response> {
  const app = new Hono();
  registerGitSyncRoutes(app);
  return app.request(`http://localhost/api/git/checkout?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch, expectedBranch }),
  });
}

async function createBranch(directory: string, name: string, expectedBranch = 'main'): Promise<Response> {
  const app = new Hono();
  registerGitSyncRoutes(app);
  return app.request(`http://localhost/api/git/branches?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expectedBranch }),
  });
}

describe('deliberate local branch checkout', () => {
  it('switches only to an existing local branch and reports the actual branch', async () => {
    const { local } = fixture(false);
    git(local, 'branch', 'feature/review');
    const response = await checkout(local, 'feature/review');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branch: 'feature/review', switched: true });
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/review');
  });

  it('refuses stale current-branch assumptions and missing local branches', async () => {
    const { local } = fixture(false);
    git(local, 'branch', 'feature/review');
    expect((await checkout(local, 'feature/review', 'old-main')).status).toBe(409);
    expect((await checkout(local, 'feature/missing')).status).toBe(404);
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('does not switch over tracked or untracked work', async () => {
    const { local } = fixture(false);
    git(local, 'branch', 'feature/review');
    writeFileSync(join(local, 'base.txt'), 'edited\n');
    expect((await checkout(local, 'feature/review')).status).toBe(409);
    git(local, 'restore', 'base.txt');
    writeFileSync(join(local, 'new.txt'), 'untracked\n');
    expect((await checkout(local, 'feature/review')).status).toBe(409);
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });
});

describe('local branch creation', () => {
  it('allows creating a branch before the first commit', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'nnd-git-unborn-'));
    const local = join(sandbox, 'local');
    execFileSync('git', ['init', '-q', '-b', 'main', local], { windowsHide: true });
    try {
      const response = await createBranch(local, 'feature/first');
      expect(response.status).toBe(200);
      expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/first');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      sandbox = null;
    }
  });

  it('creates and checks out a new local branch from the inspected HEAD', async () => {
    const { local } = fixture(false);
    const before = git(local, 'rev-parse', 'HEAD');
    const response = await createBranch(local, 'feature/new');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branch: 'feature/new', created: true });
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/new');
  });

  it('refuses duplicate names, stale current branch, and dirty work without switching', async () => {
    const { local } = fixture(false);
    git(local, 'branch', 'existing');
    expect((await createBranch(local, 'existing')).status).toBe(409);
    expect((await createBranch(local, 'fresh', 'old-main')).status).toBe(409);
    writeFileSync(join(local, 'untracked.txt'), 'draft\n');
    expect((await createBranch(local, 'fresh')).status).toBe(409);
    expect(git(local, 'branch', '--list', 'fresh')).toBe('');
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });
});

describe('explicit Git sync', () => {
  it('requires a directory, a repository, and a remote without mutating local commits', async () => {
    expect((await sync()).status).toBe(400);
    const { local } = fixture(false);
    const before = git(local, 'rev-parse', 'HEAD');
    const response = await sync(local);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('remote');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('publishes a new branch to origin and installs tracking for later syncs', async () => {
    const { local, remote } = fixture();
    git(local, 'switch', '-q', '-c', 'feature/new');
    writeFileSync(join(local, 'feature.txt'), 'feature\n');
    git(local, 'add', '-A');
    git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feature');
    const response = await sync(local);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synced: true, pushed: true, createdUpstream: true });
    expect(git(remote, 'rev-parse', 'refs/heads/feature/new')).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(git(local, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/feature/new');
    expect(await (await sync(local)).json()).toMatchObject({ synced: true, pushed: false });
  });

  it('does not guess origin when multiple remotes are available, and honors an explicit push default', async () => {
    const { local, remote, root } = fixture();
    const fork = join(root, 'fork.git');
    execFileSync('git', ['init', '-q', '--bare', fork]);
    git(local, 'remote', 'add', 'fork', fork);
    git(local, 'switch', '-q', '-c', 'feature');
    const ambiguous = await sync(local);
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json() as { error: string }).error).toContain('Choose an upstream remote');
    expect(git(remote, 'branch', '--list', 'feature')).toBe('');
    git(local, 'config', 'remote.pushDefault', 'fork');
    const selected = await sync(local);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ createdUpstream: true });
    expect(git(fork, 'rev-parse', 'refs/heads/feature')).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(git(remote, 'branch', '--list', 'feature')).toBe('');
    expect(git(local, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('fork/feature');
  });

  it('refuses a missing configured remote or an unavailable configured upstream', async () => {
    const { local, remote } = fixture();
    git(local, 'switch', '-q', '-c', 'feature');
    git(local, 'config', 'branch.feature.remote', 'missing');
    const missing = await sync(local);
    expect(missing.status).toBe(409);
    expect((await missing.json() as { error: string }).error).toContain('unavailable');
    git(local, 'config', 'branch.feature.remote', 'origin');
    git(local, 'config', 'branch.feature.merge', 'refs/heads/feature');
    const stale = await sync(local);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toContain('configured but unavailable upstream');
    expect(git(remote, 'branch', '--list', 'feature')).toBe('');
  });

  it('refuses to adopt an existing remote branch when the local branch has no upstream', async () => {
    const { local, remote, peer } = fixture();
    git(peer, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(peer, 'peer-feature.txt'), 'peer\n');
    git(peer, 'add', '-A');
    git(peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'peer feature');
    git(peer, 'push', '-q', '-u', 'origin', 'feature');
    const remoteBefore = git(remote, 'rev-parse', 'refs/heads/feature');
    git(local, 'switch', '-q', '-c', 'feature');
    const response = await sync(local);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('already exists');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(remoteBefore);
    expect(() => git(local, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toThrow();
  });

  it('pushes only the inspected commit when the branch advances during first push', async () => {
    const { local, remote } = fixture();
    git(local, 'switch', '-q', '-c', 'feature');
    const inspectedCommit = git(local, 'rev-parse', 'HEAD');
    git(local, 'config', 'core.hooksPath', '.git/hooks');
    writeFileSync(join(local, '.git', 'hooks', 'pre-push'), [
      '#!/bin/sh',
      "printf 'later\\n' > concurrent.txt",
      'git add concurrent.txt',
      "git -c commit.gpgsign=false commit -q -m 'concurrent local commit'",
      '',
    ].join('\n'));
    const response = await sync(local);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('inspected commit was pushed');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(inspectedCommit);
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(inspectedCommit);
  });

  it('does not adopt a remote branch created during first push', async () => {
    const { local, remote, peer } = fixture();
    git(local, 'switch', '-q', '-c', 'feature');
    git(peer, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(peer, 'peer-feature.txt'), 'peer\n');
    git(peer, 'add', '-A');
    git(peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'peer feature');
    const peerCommit = git(peer, 'rev-parse', 'HEAD');
    git(local, 'config', 'core.hooksPath', '.git/hooks');
    writeFileSync(join(local, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ngit -C ../peer push -q origin feature\n');
    const response = await sync(local);
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain('Push failed');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(peerCommit);
    expect(() => git(local, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toThrow();
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
