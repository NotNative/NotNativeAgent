// SPDX-License-Identifier: Apache-2.0
/** MCP config layer routes (doc 03 §5.8; doc 15 F.2). */
import type { Context, Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { createMcpConfig, deleteMcpConfig, listMcpConfig, McpConfigError,
  readMcpConfig, updateMcpConfig } from '../lib/mcp/mcp-config.ts';

const MCP_BODY_MAX = 64 * 1024;

function mutation(name: string, outcome: 'created' | 'updated' | 'deleted') {
  return {
    requiresReload: false,
    requiresRestart: true,
    restartDeferred: true,
    message: `MCP server "${name}" ${outcome}. Restart OpenCode to apply.`,
  };
}

type MappedError = { status: 400 | 404 | 500; error: string };

function errorResponse(error: unknown): MappedError {
  if (error instanceof McpConfigError) return { status: error.status, error: error.message };
  return { status: 500, error: error instanceof Error ? error.message : 'MCP configuration failed' };
}

function registerUnavailableMcpRoutes(app: Hono): void {
  // An NNA or unrecognized harness must never touch OpenCode's config files,
  // including when an old browser sends a saved request directly.
  const unavailable = (context: Context) =>
    context.json({ error: 'OpenCode MCP configuration is unavailable for this runtime' }, 409);
  app.all('/api/config/mcp', unavailable);
  app.all('/api/config/mcp/*', unavailable);
}

export function registerMcpConfigRoutes(app: Hono, legacyEnabled: boolean): void {
  if (!legacyEnabled) return registerUnavailableMcpRoutes(app);
  app.get('/api/config/mcp', async (context) => {
    try { return context.json(await listMcpConfig(context.req.query('directory'))); }
    catch (error) { const mapped = errorResponse(error); return context.json({ error: mapped.error }, mapped.status); }
  });

  app.get('/api/config/mcp/:name', async (context) => {
    const name = context.req.param('name');
    try {
      return context.json(await readMcpConfig(name, context.req.query('directory')));
    } catch (error) {
      const mapped = errorResponse(error);
      return context.json({ error: mapped.error }, mapped.status);
    }
  });

  app.post('/api/config/mcp/:name', async (context) => {
    const name = context.req.param('name');
    const body = await readJsonBodyBounded(context.req.raw, MCP_BODY_MAX);
    if (body === null) return context.json({ error: 'MCP record must be a JSON object' }, 400);
    const directory = context.req.query('directory')
      ?? (typeof body.directory === 'string' ? body.directory : undefined);
    try {
      await createMcpConfig(name, { ...body, ...(directory ? { directory } : {}) });
      return context.json(mutation(name, 'created'));
    } catch (error) {
      const mapped = errorResponse(error);
      return context.json({ error: mapped.error }, mapped.status);
    }
  });

  app.patch('/api/config/mcp/:name', async (context) => {
    const name = context.req.param('name');
    const body = await readJsonBodyBounded(context.req.raw, MCP_BODY_MAX);
    if (body === null) return context.json({ error: 'MCP patch must be a JSON object' }, 400);
    try {
      await updateMcpConfig(name, body, context.req.query('directory'));
      return context.json(mutation(name, 'updated'));
    } catch (error) {
      const mapped = errorResponse(error);
      return context.json({ error: mapped.error }, mapped.status);
    }
  });

  app.delete('/api/config/mcp/:name', async (context) => {
    const name = context.req.param('name');
    try {
      await deleteMcpConfig(name, context.req.query('directory'));
      return context.json(mutation(name, 'deleted'));
    } catch (error) {
      const mapped = errorResponse(error);
      return context.json({ error: mapped.error }, mapped.status);
    }
  });
}
