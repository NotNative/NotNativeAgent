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
  try { rmSync(joinPath(isolatedDataDir, 'preferences.json'), { force: true }); } catch { /* isolated */ }
  void globalThis;
});

describe('settings (§5.6, registry-gated per doc 14 §F.4)', () => {
  it('GET starts empty with the surface echo (computed keys only on their surfaces)', async () => {
    const body = await (await call('/api/config/settings')).json() as {
      surface: string; themeMode?: string; hasDesktopUiPassword?: boolean;
    };
    expect(body.surface).toBe('web');
    expect(body.themeMode).toBeUndefined();
    expect(body.hasDesktopUiPassword).toBeUndefined(); // desktop-only computed (§F.2)
  });

  it('PUT persists registered keys to preferences.json + mirror; unknown keys dropped', async () => {
    const first = await call('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatRenderMode: 'sorted', unknownFreshKey: { a: 1 } }),
    });
    const shape = await first.json() as { chatRenderMode?: string; unknownFreshKey?: unknown; requiresRestart: boolean; requiresReload: boolean; settings: { chatRenderMode?: string } };
    expect(shape.requiresRestart).toBe(true);
    expect(shape.requiresReload).toBe(false);
    expect(shape.settings.chatRenderMode).toBe('sorted');
    expect('unknownFreshKey' in shape.settings).toBe(false); // registry gate dropped it
    const preferencesPath = joinPath(isolatedDataDir, 'preferences.json');
    const doc = JSON.parse(readFileSync(preferencesPath, 'utf8')) as { fields: { chatRenderMode?: { value?: string } } };
    expect(doc.fields.chatRenderMode?.value).toBe('sorted'); // §F.3 split store
    const mirror = JSON.parse(readFileSync(joinPath(isolatedDataDir, 'settings.json'), 'utf8')) as { chatRenderMode?: string };
    expect(mirror.chatRenderMode).toBe('sorted'); // legacy mirror kept in sync
    await call('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeFormatPreference: '12h' }),
    });
    const after = JSON.parse(readFileSync(preferencesPath, 'utf8')) as {
      fields: { chatRenderMode?: { value?: string }; timeFormatPreference?: { value?: string } };
    };
    expect(after.fields.chatRenderMode?.value).toBe('sorted'); // untouched keys survive
    expect(after.fields.timeFormatPreference?.value).toBe('12h'); // and new keys land
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
