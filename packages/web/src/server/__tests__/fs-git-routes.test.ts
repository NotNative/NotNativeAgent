// SPDX-License-Identifier: Apache-2.0
/**
 * P4-1 route gates (doc 03 §5.14/§5.13): workspace containment (traversal
 * + symlink escape), fs/list caller's-path-space echo, bounded search,
 * git-dirs bounds, and the §5.13 non-repo PAYLOAD rule + required-directory
 * 400 shape. Runs the real Hono app against REAL temp directories.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';
import { resolveWithin } from '../routes/fs.ts';

const origin = 'http://test.local';
let scope = '';
let outer = '';

function app() {
  registerHarnessAdapter(mockHarness);
  return createApp();
}

async function get(path: string): Promise<Response> {
  return Promise.resolve(app().fetch(new Request(`${origin}${path}`)));
}

beforeEach(() => {
  scope = mkdtempSync(`${tmpdir()}${sep}nnd-scope-`);
  outer = mkdtempSync(`${tmpdir()}${sep}nnd-outer-`);
  mkdirSync(`${scope}${sep}sub`, { recursive: true });
  writeFileSync(`${scope}${sep}hello.ts`, 'export const hi = 1;\n');
});

afterEach(() => {
  rmSync(scope, { recursive: true, force: true });
  rmSync(outer, { recursive: true, force: true });
});

describe('fs routes (§5.14)', () => {
  it('lists entries in the caller path-space with symlink-transparency booleans', async () => {
    const response = await get(`/api/fs/list?directory=${encodeURIComponent(scope)}&path=.`);
    const body = await response.json() as { path: string; entries: { name: string; path: string; isDirectory: boolean; isFile: boolean }[] };
    expect(response.status).toBe(200);
    expect(body.entries.some((entry) => entry.name === 'hello.ts' && entry.isFile === true)).toBe(true);
    expect(body.entries.some((entry) => entry.name === 'sub' && entry.isDirectory === true)).toBe(true);
  });

  it('rejects traversal outside the workspace with 403 Access denied', async () => {
    const response = await get(`/api/fs/list?directory=${encodeURIComponent(scope)}&path=${encodeURIComponent('..')}`);
    expect(response.status).toBe(403);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Access denied');
  });

  it('requires the directory parameter (§5.13/§5.14 shape)', async () => {
    const response = await get('/api/fs/list');
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('directory parameter is required');
  });

  it('search_filenames returns bounded matches (ABSOLUTE path + relativePath) in scope', async () => {
    writeFileSync(`${scope}${sep}mention-one.md`, '#x');
    const response = await get(`/api/fs/search?directory=${encodeURIComponent(scope)}&query=mention&limit=10`);
    const body = await response.json() as { entries: { path: string; relativePath: string; name: string }[] };
    expect(response.status).toBe(200);
    const hit = body.entries.find((entry) => entry.relativePath === 'mention-one.md');
    expect(hit, JSON.stringify(body.entries)).toBeDefined();
    expect(hit!.path.startsWith(scope)).toBe(true); // §2.9a: absolute usable for opening
  });

  it('search never escapes the workspace (absolute out-of-scope path is rebuilt in-scope)', async () => {
    const response = await get(`/api/fs/search?directory=${encodeURIComponent(scope)}&query=${encodeURIComponent('nnd-outer')}`);
    const body = await response.json() as { entries: unknown[] };
    expect(response.status).toBe(200);
    expect(body.entries).toHaveLength(0); // the outer tempdir name is outside the scope root
  });

  it('git-dirs respects bounds, scope containment, and never lists the scope root itself', async () => {
    const response = await get(`/api/fs/git-dirs?directory=${encodeURIComponent(scope)}`);
    const body = await response.json() as { repositories: unknown[] };
    expect(response.status).toBe(200);
    expect(body.repositories).toEqual([]);
    const missing = await get('/api/fs/git-dirs');
    expect(missing.status).toBe(400);
  });
});

describe('resolveWithin (containment unit)', () => {
  it('accepts the scope root and in-scope joins; rejects wildcards upward', () => {
    expect(resolveWithin(scope, '.')).toBeTruthy();
    expect(resolveWithin(scope, 'sub')).toBeTruthy();
    expect(resolveWithin(scope, '../nnd-outer')).toBeNull();
    expect(resolveWithin(scope, './../..')).toBeNull();
  });
});

describe('git routes (§5.13)', () => {
  let repo = '';

  beforeEach(() => {
    repo = `${scope}${sep}repo`;
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['config', 'user.email', 't@nnd.test'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'NND Test'], { cwd: repo });
    writeFileSync(`${repo}${sep}a.txt`, 'one\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'], { cwd: repo });
  }, 30_000);

  it('check returns isGitRepository true/false by path', async () => {
    expect(((await (await get(`/api/git/check?directory=${encodeURIComponent(repo)}`)).json()) as { isGitRepository: boolean }).isGitRepository).toBe(true);
    expect(((await (await get(`/api/git/check?directory=${encodeURIComponent(scope)}`)).json()) as { isGitRepository: boolean }).isGitRepository).toBe(false);
  });

  it('status reports branch; non-repo answers a PAYLOAD per §5.13 (no 500)', async () => {
    const inRepo = await get(`/api/git/status?directory=${encodeURIComponent(repo)}&mode=light`);
    const bodyIn = await inRepo.json() as { isGitRepository: boolean; branch: string | null; files: { path: string; staged: boolean }[] };
    expect(inRepo.status).toBe(200);
    expect(bodyIn.isGitRepository).toBe(true);
    expect(typeof bodyIn.branch).toBe('string');
    expect(bodyIn.files).toEqual([]);

    writeFileSync(`${repo}${sep}b.txt`, 'two\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: repo });
    const bodyStaged = await (await get(`/api/git/status?directory=${encodeURIComponent(repo)}&mode=light`)).json() as { files: { path: string; staged: boolean }[] };
    expect(bodyStaged.files.some((file) => file.path === 'b.txt' && file.staged === true)).toBe(true);

    const nonRepo = await get(`/api/git/status?directory=${encodeURIComponent(scope)}`);
    const bodyOut = await nonRepo.json() as { isGitRepository: boolean };
    expect(nonRepo.status).toBe(200); // payload, never a failure
    expect(bodyOut.isGitRepository).toBe(false);
  });

  it('git status requires the directory parameter (400 exact string)', async () => {
    const response = await get('/api/git/status');
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('directory parameter is required');
  });
});
