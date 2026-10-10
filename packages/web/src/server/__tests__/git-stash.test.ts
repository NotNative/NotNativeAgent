// SPDX-License-Identifier: Apache-2.0
/** Stash lifecycle contract against an isolated local Git repo; never contacts a network. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerGitStashRoutes } from '../routes/git-stash.ts';

let sandbox: string | null = null;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(): string {
  sandbox = mkdtempSync(join(tmpdir(), 'nnd-git-stash-'));
  const local = join(sandbox, 'local');
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  git(local, 'config', 'user.name', 'NND Test');
  git(local, 'config', 'user.email', 'nnd@example.test');
  writeFileSync(join(local, 'base.txt'), 'base\n');
  git(local, 'add', '-A');
  git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  return local;
}

function app(): Hono {
  const instance = new Hono();
  registerGitStashRoutes(instance);
  return instance;
}

async function list(directory: string): Promise<Response> {
  return app().request(`http://localhost/api/git/stashes?directory=${encodeURIComponent(directory)}`);
}

async function stash(directory: string, body: Record<string, unknown> = {}): Promise<Response> {
  return app().request(`http://localhost/api/git/stash?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function apply(directory: string, ref: string, drop: boolean): Promise<Response> {
  return app().request(`http://localhost/api/git/stash-apply?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, drop }),
  });
}

function makeChange(local: string, content = 'changed\n'): void {
  writeFileSync(join(local, 'base.txt'), content);
}

describe('git stash lifecycle', () => {
  it('lists an empty array outside a repository and after a clean push', async () => {
    const response = await list(join(tmpdir(), 'nnd-not-a-repo'));
    expect(await response.json()).toEqual({ stashes: [] });
    const local = fixture();
    const empty = await stash(local);
    expect(await empty.json()).toEqual({ stashed: false, empty: true });
    expect(((await (await list(local)).json()) as { stashes: unknown[] }).stashes).toEqual([]);
  });

  it('creates a stash with a message, lists it, applies it keeping the entry, then drops it', async () => {
    const local = fixture();
    makeChange(local);
    const created = await stash(local, { message: 'wip notes' });
    expect(await created.json()).toEqual({ stashed: true, empty: false });
    const entries = ((await (await list(local)).json()) as { stashes: { ref: string; subject: string }[] }).stashes;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ref).toBe('stash@{0}');
    expect(entries[0]!.subject).toContain('wip notes');
    const restored = await apply(local, 'stash@{0}', false);
    expect(await restored.json()).toEqual({ applied: true, dropped: false });
    expect(((await (await list(local)).json()) as { stashes: unknown[] }).stashes).toHaveLength(1);
    const dropped = await apply(local, 'stash@{0}', true);
    expect(await dropped.json()).toEqual({ applied: false, dropped: true });
    expect(((await (await list(local)).json()) as { stashes: unknown[] }).stashes).toEqual([]);
    expect(git(local, 'show', 'HEAD:base.txt')).toBe('base'); // trimmed
  });

  it('rejects malformed refs and missing directories', async () => {
    const local = fixture();
    const bad = await apply(local, 'HEAD', true);
    expect(bad.status).toBe(400);
    const missing = await list('');
    expect(missing.status).toBe(400);
  });
});
