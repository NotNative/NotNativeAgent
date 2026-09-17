// SPDX-License-Identifier: Apache-2.0
// git worktree route gates (doc 03 §5.13 #61/63/66 v1) against a REAL temp
// repo: list answers the porcelain topology (empty only when not a repo),
// create mode 'new' materializes the worktree + branch at the managed root,
// remove refuses dirty worktrees (+404 on unknown/primary), and the local
// branch can be dropped with the worktree.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

/** NOTE: every module import here must stay indirect (dynamic, inside
 * beforeAll) for anything that transitively pulls server/env.ts: ENV.dataDir
 * is EAGER at module evaluation, so a static route import would land the
 * managed worktree root in the real user data dir (and collide across runs).
 * `process.env.NOTNATIVE_DATA_DIR` is only assigned in the module body. */
type WorktreeTestables = typeof import('../routes/git-worktrees.ts')['__gitWorktreeTestables'];
let worktreeTestables: WorktreeTestables | null = null;

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p63b-data-`);
const gitSandbox = mkdtempSync(`${tmpdir()}${sep}nnd-p63b-repos-`);
const repoRootPath = joinPath(gitSandbox, 'work');
const unrelatedDir = joinPath(gitSandbox, 'not-a-repo');
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
const origin = 'http://test.local';

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

beforeAll(async () => {
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'init', '-q', '-b', 'main', repoRootPath]);
  execFileSync('git', ['config', 'user.email', 't@nnd.test'], { cwd: repoRootPath });
  execFileSync('git', ['config', 'user.name', 'NND Test'], { cwd: repoRootPath });
  writeFileSync(`${repoRootPath}${sep}hello.ts`, 'one\ntwo\nthree\n');
  execFileSync('git', ['add', '-A'], { cwd: repoRootPath });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first commit'], { cwd: repoRootPath });
  worktreeTestables = (await import('../routes/git-worktrees.ts')).__gitWorktreeTestables;
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  appInstance = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
});

afterAll(() => {
  rmSync(gitSandbox, { recursive: true, force: true });
  rmSync(isolatedDataDir, { recursive: true, force: true });
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!appInstance) throw new Error('app not initialized');
  return appInstance.fetch(new Request(`${origin}${path}`, init));
}

/** Route call that prints the error body on a status miss: 500s carry git stderr. */
async function expectRoutedStatus(path: string, init: RequestInit | undefined, status: number): Promise<{ raw: Response; body: Record<string, unknown>; text: string }> {
  const response = await call(path, init);
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`unexpected ${response.status} (wanted ${status}) from ${init?.method ?? 'GET'} ${path}: ${text}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch { /* empty body */ }
  return { raw: response, body, text };
}

const DIRQ = `?directory=${encodeURIComponent(repoRootPath)}`;
async function listWorktrees(query = DIRQ): Promise<{ worktrees: { path: string; head: string | null; branch: string | null; detached: boolean; linked: boolean }[] }> {
  return await (await call(`/api/git/worktrees${query}`)).json() as { worktrees: { path: string; head: string | null; branch: string | null; detached: boolean; linked: boolean }[] };
}

describe('git worktree routes v1 (doc 03 §5.13 #61/63/66)', () => {
  it('lists the primary worktree; non-repo answers an EMPTY list, not an error', async () => {
    const topology = await listWorktrees();
    expect(topology.worktrees).toHaveLength(1);
    expect(topology.worktrees[0]!.path.replaceAll('\\', '/').toLowerCase()).toBe(repoRootPath.replaceAll('\\', '/').toLowerCase());
    expect(topology.worktrees[0]!.branch).toBe('main');
    expect(topology.worktrees[0]!.linked).toBe(false);
    const empty = await listWorktrees(`?directory=${encodeURIComponent(unrelatedDir)}`);
    expect(empty.worktrees).toEqual([]);
    const missing = await call('/api/git/worktrees');
    expect(missing.status).toBe(400);
  });

  it('create mode new materializes the worktree + branch at the managed root', async () => {
    const routed = await expectRoutedStatus(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'feat/one' }),
    }, 200);
    const payload = { worktree: routed.body.worktree as { path: string; branch: string; linked: boolean } };
    expect(payload.worktree.branch).toBe('feat/one');
    expect(payload.worktree.path).toContain('git-worktrees');
    expect(payload.worktree.linked).toBe(true);
    expect(existsSync(joinPath(payload.worktree.path, 'hello.ts'))).toBe(true); // checked out
    const branch = execFileSync('git', ['branch', '--list', 'feat/one'], { cwd: repoRootPath }).toString();
    expect(branch.trim().length).toBeGreaterThan(0);
    const topology = await listWorktrees();
    expect(topology.worktrees).toHaveLength(2);
    expect(topology.worktrees[1]!.linked).toBe(true);
  });

  it('create twice on the same branch fails 500; missing branchName; non-new mode; non-repo create 400s', async () => {
    const duplicate = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'feat/one' }),
    });
    expect(duplicate.status).toBe(500);
    const noBranch = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new' }),
    });
    expect(noBranch.status).toBe(400);
    const badMode = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'churn', branchName: 'x' }),
    });
    expect(badMode.status).toBe(400);
    const nonRepo = await call(`/api/git/worktrees?directory=${encodeURIComponent(unrelatedDir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'x' }),
    });
    expect(nonRepo.status).toBe(400);
  });

  it('create lacks a branchName only from branchName (a custom worktreeName cannot mask it)', async () => {
    const masked = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', worktreeName: 'sneaky' }),
    });
    expect(masked.status).toBe(400); // v0 answered git's 500 for `add -b ''`; the contract is a 400
  });

  it('a traversal-shaped worktreeName is slug-sanitized inside the managed root', async () => {
    const routed = await expectRoutedStatus(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'feat/escape', worktreeName: '../evil' }),
    }, 200);
    const payload = { worktree: routed.body.worktree as { path: string } };
    expect(payload.worktree.path.replaceAll('\\', '/')).not.toContain('..'); // no managed-root escape
    expect(payload.worktree.path.replaceAll('\\', '/').endsWith('/evil')).toBe(true); // the sanitized name survives on the managed root
    expect(existsSync(joinPath(payload.worktree.path, 'hello.ts'))).toBe(true);
    const other = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'feat/escape2', worktreeName: 'C:' }),
    });
    expect(other.status).toBe(200); // a drive prefix cannot reach the filesystem either
    expect(existsSync((await other.json() as { worktree: { path: string } }).worktree.path)).toBe(true);
  });

  it('DELETE in a non-repo is an unknown-worktree 404, not a 500', async () => {
    const response = await call(`/api/git/worktrees?directory=${encodeURIComponent(unrelatedDir)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: joinPath(gitSandbox, 'nowhere') }),
    });
    expect(response.status).toBe(404);
  });

  it('remove refuses a DIRTY worktree and removes a clean one (primary/unknown are 404)', async () => {
    const routed = await expectRoutedStatus(`/api/git/worktrees${DIRQ}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', branchName: 'feat/two', worktreeName: 'custom-two' }),
    }, 200);
    const { worktree } = { worktree: routed.body.worktree as { path: string; branch: string } };
    const pathQ = `/api/git/worktrees${`?directory=${encodeURIComponent(worktree.path)}`}`;

    const primary = await call(`/api/git/worktrees${DIRQ}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: repoRootPath }),
    });
    expect(primary.status).toBe(404); // primary entries are not removable here
    const unknown = await call(pathQ, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: joinPath(gitSandbox, 'nowhere') }),
    });
    expect(unknown.status).toBe(404);

    writeFileSync(`${worktree.path}${sep}hello.ts`, 'one\ntwo CHANGED\nthree\n');
    const dirty = await call(pathQ, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: worktree.path }),
    });
    expect(dirty.status).toBe(500);
    expect(existsSync(worktree.path)).toBe(true); // the dirty worktree is protected

    execFileSync('git', ['checkout', '--', 'hello.ts'], { cwd: worktree.path });
    const clean = await call(pathQ, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: worktree.path, deleteLocalBranch: true }),
    });
    const removed = await clean.text() as string;
    const cleanBody = JSON.parse(removed) as { success: boolean; branch: string | null };
    expect(clean.status, `clean remove failed: ${removed}`).toBe(200);
    expect(cleanBody.success).toBe(true);
    expect(cleanBody.branch).toBe('feat/two');
    expect(existsSync(worktree.path)).toBe(false);
    const branch = execFileSync('git', ['branch', '--list', 'feat/two'], { cwd: repoRootPath }).toString();
    expect(branch.trim()).toBe('');
  });

  it('parses porcelain blocks with CRLF line endings (Windows stdout safety)', () => {
    const parsed = worktreeTestables!.parsePorcelainWorktrees(
      `worktree ${repoRootPath}\r\nHEAD abc1234\r\nbranch refs/heads/main\r\n\r\nworktree C:\\wt\r\nbranch refs/heads/feat/one\r\n`,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.branch).toBe('main');
    expect(parsed[0]!.head).toBe('abc1234');
    expect(parsed[1]!.linked).toBe(true);
    expect(parsed[1]!.path).toBe('C:\\wt');
    expect(worktreeTestables!.slugOf('../..\\evil')).toBe('evil'); // the managed-root guard keeps traversal out
  });
});
