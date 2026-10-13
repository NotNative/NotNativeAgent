// SPDX-License-Identifier: Apache-2.0
/** Native Git and file routes must use a workspace NNA admitted for this principal.
 * The worktree family performs its own preflight because removal also revokes
 * the target root. The two walkthrough POSTs carry their directory in JSON;
 * other Git routes use the query parameter. */
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { getHarnessAdapter } from '../harness/adapter.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { assertNativeWorkspaceRoot, WorkspaceAdmissionError } from './native-workspace-admission.ts';

const BODY_DIRECTORY_ROUTES = new Set(['/api/git/walkthrough-generate', '/api/git/walkthrough-cancel']);

export function registerNativeLocalScope(app: Hono): void {
  for (const family of ['/api/git/*', '/api/fs/*']) app.use(family, async (context, next) => {
    if (ENV.harness === 'mock' || getHarnessAdapter().mode === 'mock'
      || context.req.path === '/api/git/worktrees') return next();
    let directory: unknown = context.req.query('directory');
    if (BODY_DIRECTORY_ROUTES.has(context.req.path) && context.req.method === 'POST') {
      const body = await readJsonBodyBounded(context.req.raw.clone(), 4_096);
      directory = body?.directory;
    }
    // Every route owns its missing-directory grammar; this gate owns only
    // authorization of a supplied root before local Git touches it.
    if (!directory) return next();
    try { await assertNativeWorkspaceRoot(directory); }
    catch (error) {
      const failure = error instanceof WorkspaceAdmissionError ? error
        : new WorkspaceAdmissionError('NNA workspace identity is unavailable.', 503);
      return Response.json({ error: failure.message }, { status: failure.status });
    }
    return next();
  });
}
