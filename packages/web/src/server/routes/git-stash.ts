// SPDX-License-Identifier: Apache-2.0
/**
 * Git stash routes v1 (F6.3 "history/graph/stashes" stash lifecycle):
 * list (`stash list` with subject), create (`stash push -m`, tracked changes
 * only), and apply/drop (`stash apply|pop <ref>`). 409 when git reports
 * "No local changes to save" so the UI can show an empty-state instead of a
 * failure. All routes REQUIRE ?directory and reuse the git.ts repo checks.
 */
import { execFileSync } from 'node:child_process';
import type { Hono } from 'hono';
import { isGitRepository } from './git.ts';

const GIT_TIMEOUT_MS = 15_000;

interface GitRun { status: number; stdout: string; stderr: string }

function git(args: string[], directory: string): GitRun {
  try {
    const stdout = execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: failure.status ?? 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: failure.stderr?.trim() || failure.message || 'git stash failed',
    };
  }
}

function stashRefIsValid(ref: string): boolean {
  return /^stash@\{\d{1,3}\}$/u.test(ref);
}

async function readJsonBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json() as unknown;
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function registerGitStashRoutes(app: Hono): void {
  app.get('/api/git/stashes', (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    if (!isGitRepository(directory)) return Response.json({ stashes: [] });
    const run = git(['stash', 'list', '--pretty=format:%gd%x09%gs'], directory);
    if (run.status !== 0) return Response.json({ error: run.stderr || 'git stash list failed' }, { status: 500 });
    const stashes = run.stdout.split('\n').filter((line) => line.trim().length > 0).map((line) => {
      const at = line.indexOf('\t');
      return { ref: line.slice(0, at), subject: line.slice(at + 1) };
    });
    return Response.json({ stashes });
  });

  app.post('/api/git/stash', async (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    if (!isGitRepository(directory)) return Response.json({ error: 'not a git repository' }, { status: 400 });
    const body = await readJsonBody(context.req);
    const message = typeof body?.message === 'string' && body.message.trim().length > 0 ? body.message.trim().slice(0, 200) : null;
    const args = message === null ? ['stash', 'push'] : ['stash', 'push', '-m', message];
    const run = git(args, directory);
    const noChanges = /No local changes to save/u.test(run.stdout) || /No local changes to save/u.test(run.stderr);
    if (noChanges) return Response.json({ stashed: false, empty: true });
    if (run.status !== 0) return Response.json({ error: run.stderr || 'git stash push failed' }, { status: 500 });
    return Response.json({ stashed: true, empty: false });
  });

  app.post('/api/git/stash-apply', async (context) => {
    const directory = context.req.query('directory');
    if (!directory) return Response.json({ error: 'directory parameter is required' }, { status: 400 });
    if (!isGitRepository(directory)) return Response.json({ error: 'not a git repository' }, { status: 400 });
    const body = await readJsonBody(context.req);
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const drop = body?.drop === true;
    if (!stashRefIsValid(ref)) return Response.json({ error: 'ref must look like stash@{n}' }, { status: 400 });
    const run = git(drop ? ['stash', 'drop', ref] : ['stash', 'apply', ref], directory);
    if (run.status !== 0) return Response.json({ error: run.stderr || 'git stash operation failed' }, { status: 409 });
    return Response.json({ applied: !drop, dropped: drop });
  });
}
