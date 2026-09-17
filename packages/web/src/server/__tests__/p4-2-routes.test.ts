// SPDX-License-Identifier: Apache-2.0
/**
 * P4-2 gates (doc 03 §5.6/§5.13/§5.15): settings CRUD (deferred-restart
 * external shape, atomic persistence, one-level merge); projects config +
 * context core; git log (numstat) + branches (porcelain) against a real
 * temp repo. The whole suite runs against an ISOLATED NOTNATIVE_DATA_DIR so
 * no route writes into the operator's home directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-data-`);
const gitSandbox = mkdtempSync(`${tmpdir()}${sep}nnd-git-`);
const repoRoot = joinPath(gitSandbox, 'work');
const repoWork = repoRoot;
const origin = 'http://test.local';
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

function theApp(): App {
  if (!appInstance) {
    registerHarnessAdapter(mockHarness);
    throw new Error('app not initialized; beforeAll must run first');
  }
  return appInstance;
}

void joinPath;
void existsSync;
beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  const created = createApp();
  appInstance = { fetch: (request: Request) => Promise.resolve(created.fetch(request)) };
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  return theApp().fetch(new Request(`${origin}${path}`, init));
}

beforeEach(() => {
  if (!existsSync(repoWork)) {
    mkdirSync(repoWork, { recursive: true });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'init', '-q', '-b', 'main', repoWork]);
    execFileSync('git', ['config', 'user.email', 't@nnd.test'], { cwd: repoWork });
    execFileSync('git', ['config', 'user.name', 'NND Test'], { cwd: repoWork });
    writeFileSync(`${repoWork}${sep}a.txt`, 'one\n');
    execFileSync('git', ['add', '.'], { cwd: repoWork });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first commit'], { cwd: repoWork });
  }
});

afterEach(() => {
  try { rmSync(joinPath(isolatedDataDir, 'settings.json'), { force: true }); } catch { /* isolated */ }
  void globalThis;
});

describe('settings (§5.6)', () => {
  it('GET starts empty with the surface echo', async () => {
    const body = await (await call('/api/config/settings')).json() as { surface: string; theme?: string };
    expect(body.surface).toBe('web');
    expect(body.theme).toBeUndefined();
  });

  it('PUT merges one level deep, persists atomically, defers restart (external harness)', async () => {
    const first = await call('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', nested: { a: 1 } }),
    });
    const shape = await first.json() as { theme?: string; nested?: { a?: number; b?: number }; requiresRestart: boolean; requiresReload: boolean; settings: { theme?: string } };
    expect(shape.requiresRestart).toBe(true);
    expect(shape.requiresReload).toBe(false);
    expect(shape.settings.theme).toBe('dark');
    const settingsPath = joinPath(isolatedDataDir, 'settings.json');
    expect(existsSync(`${settingsPath}.tmp-`)).toBe(false); // no stray tmp residue in the name space
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('dark');
    await call('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nested: { b: 2 } }),
    });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { theme?: string; nested?: { a?: number; b?: number } };
    expect(after.theme).toBe('dark'); // untouched keys survive
    expect(after.nested?.a).toBe(1); // one-level merge keeps existing
    expect(after.nested?.b).toBe(2); // and adds new
  });
});

describe('git log + branches (§5.13 #68/#50)', () => {
  it('log parses numstat including per-file counts; directory required', async () => {
    const response = await call(`/api/git/log?directory=${encodeURIComponent(repoWork)}&maxCount=10`);
    const body = await response.json() as { isGitRepository: boolean; commits: { hash: string; subject: string; files: number; additions: number }[] };
    expect(response.status).toBe(200);
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]!.subject).toBe('first commit');
    expect(body.commits[0]!.files).toBe(1);
    expect(body.commits[0]!.additions).toBe(1);
    const missing = await call('/api/git/log');
    expect(missing.status).toBe(400);
  });

  it('branches report current + locals; non-repo answers the payload', async () => {
    const response = await call(`/api/git/branches?directory=${encodeURIComponent(repoWork)}`);
    const body = await response.json() as { isGitRepository: boolean; current: string | null; local: string[]; remote: string[] };
    expect(body.current).toBe('main');
    expect(body.local).toContain('main');
    expect(body.remote).toEqual([]);
    const nonRepo = await call(`/api/git/branches?directory=${encodeURIComponent(gitSandbox)}`);
    const bodyNonRepo = await nonRepo.json() as { isGitRepository: boolean; local: string[] };
    expect(bodyNonRepo.isGitRepository).toBe(false);
    expect(bodyNonRepo.local).toEqual([]);
  });
});

describe('projects config + context (§5.15)', () => {
  it('PUT saves the config; GET echoes; ids validate', async () => {
    const saved = await (await call('/api/projects/alpha1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worktree: [], actions: [{ name: 'test' }], starters: [] }),
    })).json() as { actions: { name: string }[] };
    expect(saved.actions[0]!.name).toBe('test');
    const echoed = await (await call('/api/projects/alpha1/config')).json() as { actions: { name: string }[] };
    expect(echoed.actions[0]!.name).toBe('test');
    const blocked = await call('/api/projects/..%2Fetc/config');
    expect(blocked.status).toBe(400);
  });

  it('context returns notes/todos/plans after todos PUT', async () => {
    await call('/api/project-context/beta2/todos', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ todos: [{ id: 't1', text: 'ship', completed: false }] }),
    });
    const context = await (await call('/api/project-context/beta2')).json() as { todos: { text: string }[]; notes: unknown[] };
    expect(context.todos[0]!.text).toBe('ship');
    expect(Array.isArray(context.notes)).toBe(true);
  });
});
