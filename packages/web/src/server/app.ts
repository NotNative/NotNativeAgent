// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { ENV } from './env.ts';
import { getHarnessAdapter } from './harness/adapter.ts';
import { getUiAuthController, CLEAR_SESSION_COOKIE_HEADER, type AuthOutcome } from './lib/auth/ui-auth.ts';
import { createStaticHandler, DIST_DIR } from './lib/static.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createNotNativeRoutes } from './routes/notnative.ts';
import { registerFsRoutes } from './routes/fs.ts';
import { registerFsReadRoutes } from './routes/fs-read.ts';
import { registerGitDiffRoutes } from './routes/git-diff.ts';
import { registerGitRoutes } from './routes/git.ts';
import { registerGitWorktreeRoutes } from './routes/git-worktrees.ts';
import { registerSettingsRoutes, registerProjectsRoutes, registerGitReadRoutes } from './routes/projects.ts';
import { registerFsWriteRoutes } from './routes/fs-write.ts';
import { registerSessionFoldersRoutes } from './routes/session-folders.ts';
import { registerTerminalRoutes } from './terminal/routes.ts';
import { createTerminalRuntime } from './terminal/bootstrap.ts';
import type { TerminalRuntime } from './terminal/session-core.ts';

/**
 * Session list sanitation (doc 02 §3.2): server-side keep-list, `summary`
 * minus `diffs`, `revert` reduced to `{messageID, partID?}`.
 */
const SESSION_KEEP = [
  'id', 'slug', 'projectID', 'workspaceID', 'directory', 'path', 'parentID', 'title',
  'agent', 'model', 'version', 'time', 'cost', 'tokens', 'share', 'metadata', 'project',
] as const;

function sanitizeSession(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SESSION_KEEP) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  if (raw.summary && typeof raw.summary === 'object') {
    const { diffs: _dropped, ...summary } = raw.summary as Record<string, unknown>;
    void _dropped;
    out.summary = summary;
  }
  if (raw.revert && typeof raw.revert === 'object') {
    const { messageID, partID } = raw.revert as { messageID?: string; partID?: string };
    out.revert = partID ? { messageID, partID } : { messageID };
  }
  return out;
}

async function sanitizeSessionList(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('application/json')) return response;
  try {
    const body = await response.json();
    if (!Array.isArray(body)) return response;
    return new Response(JSON.stringify(body.map((s) => sanitizeSession(s as Record<string, unknown>))), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return response;
  }
}

async function apiAuthGate(c: Context, next: Next): Promise<Response | void> {
  const controller = getUiAuthController();
  const outcome: AuthOutcome = controller.authenticate(
    c.req.raw.headers,
    new URL(c.req.raw.url),
    c.req.method,
  );
  if (outcome.ok) return next();
  const headers = new Headers();
  for (const [name, value] of Object.entries(outcome.headers)) headers.set(name, value);
  if (outcome.clearSessionCookie) headers.append('set-cookie', CLEAR_SESSION_COOKIE_HEADER);
  return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers });
}

export function createApp(options?: { terminal?: TerminalRuntime }) {
  const app = new Hono();
  const terminal = options?.terminal ?? createTerminalRuntime();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      name: ENV.appName,
      version: ENV.version,
      runtime: process.env?.NOTNATIVE_RUNTIME ?? 'web',
      // HP-9: keep the field name — the UI feature-flag wiring depends on it
      planModeExperimentalEnabled: ENV.planModeExperimentalEnabled,
    }),
  );

  app.route('/', createAuthRoutes());
  // Global /api gate (doc 08 §2.2 requireAuth): cookie session, client
  // bearer, or allowlisted URL token. Registered after the /auth routes so
  // their bespoke headers (login/reset) run un-wrapped; every later /api
  // surface + the harness proxy rides behind it.
  app.use('/api/*', apiAuthGate);
  registerApiSurfaces(app, terminal);

  // Harness proxy: everything under /api goes through the seam (HP-1).
  app.all('/api/*', async (c) => {
    try {
      const response = await getHarnessAdapter().handle(c.req.raw);
      const listPath = /^\/api\/(experimental\/)?session$/.test(new URL(c.req.raw.url).pathname);
      if (listPath && c.req.method === 'GET') return await sanitizeSessionList(response);
      return response;
    } catch (error) {
      return c.json(
        { error: { message: `harness request failed: ${String(error)}` } },
        502,
      );
    }
  });

  // Static UI (production builds; dev is served by Vite)
  const serveStatic = createStaticHandler(DIST_DIR);
  app.all('*', async (c, next) => {
    const response = await serveStatic(c.req.raw);
    if (response) return response;
    return next();
  });

  app.notFound((c) =>
    c.json({ error: { message: `not found: ${new URL(c.req.raw.url).pathname}` } }, 404),
  );

  return app;
}

/** NND-owned /api surfaces (P4/P6/P7 slices): registered between the auth
 * gate and the harness-proxy catch-all (Hono matches in registration
 * order, doc 03 §5.14/§5.13 — nothing may register after the proxy). */
function registerApiSurfaces(app: Hono, terminal: TerminalRuntime): void {
  app.route('/', createNotNativeRoutes());
  registerFsRoutes(app);
  registerFsReadRoutes(app);
  registerGitDiffRoutes(app);
  registerGitRoutes(app);
  registerGitWorktreeRoutes(app);
  registerTerminalRoutes(app, terminal);
  registerSettingsRoutes(app);
  registerProjectsRoutes(app);
  registerGitReadRoutes(app);
  registerFsWriteRoutes(app);
  registerSessionFoldersRoutes(app);
}
