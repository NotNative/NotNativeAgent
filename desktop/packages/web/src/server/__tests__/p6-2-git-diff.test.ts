// SPDX-License-Identifier: Apache-2.0
// git-diff/git read+write route gates (doc 03 §5.13/§5.16 subset + doc 06
// §5.6.d): per-file diff w/ --cached, apply-hunk with the exactly-one-hunk
// rule, stage/unstage/discard, commit; against a REAL temp repo.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p62-`);
const gitSandbox = mkdtempSync(`${tmpdir()}${sep}nnd-repo-`);
const repoRootPath = joinPath(gitSandbox, 'work');
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
const origin = 'http://test.local';
const GITENV = ['-c', 'commit.gpgsign=false'];

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

beforeAll(async () => {
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'init', '-q', '-b', 'main', repoRootPath]);
  execFileSync('git', ['config', 'user.email', 't@nnd.test'], { cwd: repoRootPath });
  execFileSync('git', ['config', 'user.name', 'NND Test'], { cwd: repoRootPath });
  writeFileSync(`${repoRootPath}${sep}hello.ts`, 'one\ntwo\nthree\n');
  execFileSync('git', ['add', '-A'], { cwd: repoRootPath });
  execFileSync('git', [...GITENV, 'commit', '-q', '-m', 'first commit'], { cwd: repoRootPath });
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  appInstance = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!appInstance) throw new Error('app not initialized');
  return appInstance.fetch(new Request(`${origin}${path}`, init));
}

const DIRQ = `?directory=${encodeURIComponent(repoRootPath)}`;

async function applyHunkBootTest(patch: string): Promise<Response> {
  return call(`/api/git/apply-hunk${DIRQ}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'hello.ts', patch, action: 'stage' }),
  });
}

describe('git diff + mutations (doc 06 §5.6/§6.4)', () => {
  it('returns a bounded read-only patch for an untracked file without staging it', async () => {
    const previewDirectory = joinPath(repoRootPath, 'preview-nested');
    mkdirSync(previewDirectory);
    const previewPath = joinPath(previewDirectory, 'preview-untracked.txt');
    writeFileSync(previewPath, 'new content\n');
    try {
      const working = await call(`/api/git/diff${DIRQ}&path=preview-nested%2Fpreview-untracked.txt&staged=false&contextLines=3`);
      expect(working.status).toBe(200);
      const patch = await working.json() as { diff: string };
      expect(patch.diff).toContain('--- /dev/null');
      expect(patch.diff).toContain('+new content');
      expect(patch.diff).toContain('b/preview-nested/preview-untracked.txt');
      execFileSync('git', ['apply', '--cached', '--check', '-'], { cwd: repoRootPath, input: patch.diff });
      const staged = await (await call(`/api/git/diff${DIRQ}&path=preview-nested%2Fpreview-untracked.txt&staged=true&contextLines=3`)).json() as { diff: string };
      expect(staged.diff).toBe('');
      writeFileSync(previewPath, 'x'.repeat(2_000_001));
      expect((await call(`/api/git/diff${DIRQ}&path=preview-nested%2Fpreview-untracked.txt&staged=false&contextLines=3`)).status).toBe(413);
    } finally {
      rmSync(previewDirectory, { recursive: true, force: true });
    }
  });

  it('keeps nested workspace status, diff, and staging in repository-root path space', async () => {
    const nested = joinPath(repoRootPath, 'nested-workspace');
    mkdirSync(nested);
    writeFileSync(joinPath(nested, 'authored.txt'), 'nested content\n');
    const sibling = joinPath(repoRootPath, 'outside-workspace.txt');
    writeFileSync(sibling, 'outside\n');
    const query = `?directory=${encodeURIComponent(nested)}`;
    const path = 'nested-workspace/authored.txt';
    try {
      const status = await (await call(`/api/git/status${query}`)).json() as {
        workspacePrefix: string; files: Array<{ path: string }>;
      };
      expect(status.workspacePrefix).toBe('nested-workspace/');
      expect(status.files.some((entry) => entry.path === path)).toBe(true);
      expect(status.files.some((entry) => entry.path === 'outside-workspace.txt')).toBe(false);
      expect((await call(`/api/git/diff${query}&path=hello.ts&staged=false`)).status).toBe(403);
      const mixedStage = await call(`/api/git/stage${query}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [path, 'hello.ts'] }) });
      expect(mixedStage.status).toBe(403);
      expect((await (await call(`/api/git/diff${query}&path=${encodeURIComponent(path)}&staged=true`)).json() as { diff: string }).diff).toBe('');
      const siblingDiscard = await call(`/api/git/discard${query}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: ['hello.ts'] }) });
      expect(siblingDiscard.status).toBe(403);
      const working = await (await call(`/api/git/diff${query}&path=${encodeURIComponent(path)}&staged=false`)).json() as { diff: string };
      expect(working.diff).toContain('+nested content');
      const staged = await call(`/api/git/stage${query}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [path] }) });
      expect(staged.status).toBe(200);
      const index = await (await call(`/api/git/diff${query}&path=${encodeURIComponent(path)}&staged=true`)).json() as { diff: string };
      expect(index.diff).toContain('+nested content');
      const unstaged = await call(`/api/git/unstage${query}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [path] }) });
      expect(unstaged.status).toBe(200);
    } finally {
      rmSync(nested, { recursive: true, force: true });
      rmSync(sibling, { force: true });
    }
  });

  it('diff answers the patch (worktree edit visible; --cached side empty)', async () => {
    writeFileSync(`${repoRootPath}${sep}hello.ts`, 'one\ntwo modified\nthree\n');
    const work = await (await call(`/api/git/diff${DIRQ}&path=hello.ts&staged=false&contextLines=3`)).json() as { diff: string };
    expect(work.diff).toContain('+two modified');
    expect(work.diff).toContain('-two');
    const staged = await (await call(`/api/git/diff${DIRQ}&path=hello.ts&staged=true&contextLines=3`)).json() as { diff: string };
    expect(staged.diff).not.toContain('+two modified');
  });

  it('apply-hunk: one hunk applies to the index; two hunks is 400', async () => {
    const diff = await (await call(`/api/git/diff${DIRQ}&path=hello.ts&staged=false&contextLines=3`)).json() as { diff: string };
    expect(await (await applyHunkBootTest(diff.diff)).json() as { applied?: string }).toMatchObject({ applied: 'stage' });
    const staged = await (await call(`/api/git/diff${DIRQ}&path=hello.ts&staged=true&contextLines=3`)).json() as { diff: string };
    expect(staged.diff).toContain('+two modified');
    const twoHunks = `${diff.diff}\n\n@@ -99,1 +99,1 @@\n-ghost\n+phantom\n`;
    expect((await applyHunkBootTest(twoHunks)).status).toBe(400);
  });

  it('stage/unstage round-trips via the queue routes', async () => {
    writeFileSync(`${repoRootPath}${sep}new.txt`, 'fresh\n');
    const add = await call(`/api/git/stage${DIRQ}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['new.txt'] }) });
    expect(add.status).toBe(200);
    const staged = await (await call(`/api/git/diff${DIRQ}&path=new.txt&staged=true&contextLines=3`)).json() as { diff: string };
    expect(staged.diff).toContain('+fresh');
    const unstage = await call(`/api/git/unstage${DIRQ}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['new.txt'] }) });
    expect(unstage.status).toBe(200);
    rmSync(joinPath(repoRootPath, 'new.txt'), { force: true });
  });

  it('commit requires a message and creates a commit', async () => {
    const missing = await call(`/api/git/commit${DIRQ}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '  ' }) });
    expect(missing.status).toBe(400);
    execFileSync('git', ['add', '-A'], { cwd: repoRootPath });
    const commit = await (await call(`/api/git/commit${DIRQ}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'work: p62 test' }) })).json() as { committed: boolean; hash: string | null };
    expect(commit.committed).toBe(true);
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/u);
  });
});
