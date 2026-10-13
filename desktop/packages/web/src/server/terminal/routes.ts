// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal HTTP command plane (doc 07 section 3.7): JSON routes with the
 * 3.7 error envelope; the only recoverable 400 is TERMINAL_CWD_MISSING
 * (deleted worktree). Listings never include command text. Reload/restart/
 * close/kill semantics live in the runtime; this module is transport only
 * (validation incl. force-kill targeting raises TerminalRequestError and
 * rides the same envelope).
 */
import type { Hono } from 'hono';
import { TerminalRequestError, normalizeDirectory, type TerminalRuntime } from './session-core.ts';
import type { CreateTerminalOptions, TerminalAppearance } from './types.ts';

export function registerTerminalRoutes(app: Hono, runtime: TerminalRuntime): void {
  app.get('/api/terminal/shells', (context) => Response.json(runtime.shells()));

  app.get('/api/terminal/sessions', (context) => {
    const cwd = context.req.query('cwd');
    const sessions = runtime.listSessions().filter((session) => !cwd || normalizeDirectory(session.cwd) === normalizeDirectory(cwd));
    return Response.json({ sessions });
  });

  app.post('/api/terminal/create', async (context) => {
    const body = await readJson(context.req);
    return guard(async () => {
      const created = await runtime.createSession(body as never);
      return Response.json(created, { status: 200 });
    });
  });

  app.post('/api/terminal/:id/resize', async (context) => {
    const body = await readJson(context.req);
    return guard(async () => Response.json(runtime.resize(context.req.param('id'), Number(body['cols']), Number(body['rows']))));
  });

  app.post('/api/terminal/:id/appearance', async (context) => {
    const body = await readJson(context.req);
    return guard(async () => Response.json(runtime.updateAppearance(context.req.param('id'), body as TerminalAppearance)));
  });

  app.post('/api/terminal/:id/restart', async (context) => {
    const body = await readJson(context.req);
    return guard(async () => Response.json(await runtime.restart(context.req.param('id'), body as Partial<CreateTerminalOptions>)));
  });

  app.delete('/api/terminal/:id', (context) => {
    return guard(() => Response.json(runtime.close(context.req.param('id'))));
  });

  app.post('/api/terminal/force-kill', async (context) => {
    const body = await readJson(context.req);
    return guard(async () => Response.json(runtime.forceKill(body as { sessionId?: string; cwd?: string })));
  });

  app.post('/api/terminal/touch', async (context) => {
    const body = await readJson(context.req);
    const raw = (body as { sessionIds?: unknown }).sessionIds;
    const sessionIds = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
    return guard(async () => Response.json(runtime.touch(sessionIds)));
  });
}

async function guard(handler: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof TerminalRequestError) return Response.json(error.payload, { status: error.status });
    return Response.json({ error: error instanceof Error ? error.message : 'terminal command failed' }, { status: 500 });
  }
}

/** JSON body reader: non-objects (strings/arrays) read as {} so validation
 * downstream still runs and answers the documented 400 envelope. */
async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return isPlainObject(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
