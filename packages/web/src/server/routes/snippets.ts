// SPDX-License-Identifier: Apache-2.0
/**
 * Snippet config-entity routes (doc 03 §5.x "Snippets", NND addition):
 * GET list `{snippets}`, GET/POST/PATCH/DELETE per name, and the
 * `POST /expand {text}` route that answers `{text: expanded}`. Body reads
 * ride the shared bounded reader (malformed/oversize fold to one 400).
 * The `:name` POST is registered AFTER `/expand` so the reserved word
 * cannot shadow the expansion route (Hono first-match order).
 */
import { Hono, type Context } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import {
  deleteSnippet, expandSnippetText, listSnippets, readSnippet, resolveStoredName,
  snippetNameOk, snippetNameReserved, writeSnippet, type SnippetRecord,
} from '../snippets/snippet-store.ts';

const BODY_MAX = 64 * 1024;

export interface SnippetRouteOptions {
  /** Data-dir override for tests; production rides ENV.dataDir. */
  dataDir?: string;
}

function fail(c: Context, status: 400 | 404 | 409, message: string): Response {
  return c.json({ error: message }, status);
}

/** The family's name gate: the pattern, then Windows-reserved device names
 * (unwritable user files on enforcing volumes - a 400, not a write crash). */
function nameGuard(c: Context, name: string): Response | null {
  if (!snippetNameOk(name)) return fail(c, 400, 'snippet name must match [\\w-]{1,64}');
  if (snippetNameReserved(name)) return fail(c, 400, 'snippet name is reserved on this platform');
  return null;
}

/** A record from a body: `text` required, `scope` optional string; the
 * route name is the authority regardless of any body `name`. */
function sanitizeBody(body: Record<string, unknown>, name: string): SnippetRecord | string {
  const text = body.text;
  if (typeof text !== 'string') return 'snippet text must be a string';
  if (text.length === 0) return 'snippet text must not be empty';
  const scope = body.scope;
  if (scope !== undefined && typeof scope !== 'string') return 'snippet scope must be a string';
  return { name, text, scope: (scope as string | undefined) ?? 'global' };
}

async function expandTextHandler(c: Context, dataDir: string | undefined): Promise<Response> {
  const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
  if (body === null) return fail(c, 400, 'expand body must be a JSON object');
  const { text } = body;
  if (typeof text !== 'string') return fail(c, 400, 'expand text must be a string');
  return c.json({ text: expandSnippetText(text, await listSnippets(dataDir)) });
}

export function registerSnippetRoutes(app: Hono, options: SnippetRouteOptions = {}): void {
  const dataDir = options.dataDir;

  app.post('/api/config/snippets/expand', (c) => expandTextHandler(c, dataDir));

  app.get('/api/config/snippets', async (c) => c.json({ snippets: await listSnippets(dataDir) }));

  app.get('/api/config/snippets/:name', async (c) => {
    const name = c.req.param('name');
    const refused = nameGuard(c, name); if (refused !== null) return refused;
    const stored = await resolveStoredName(name, dataDir);
    if (stored === null) return fail(c, 404, 'snippet not found');
    const record = await readSnippet(stored, dataDir);
    if (record === null) return fail(c, 404, 'snippet not found');
    return c.json(record);
  });

  app.post('/api/config/snippets/:name', async (c) => {
    const name = c.req.param('name');
    const refused = nameGuard(c, name); if (refused !== null) return refused;
    const existing = await readSnippet(name, dataDir);
    if (existing !== null) return fail(c, 409, 'snippet exists');
    const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
    if (body === null) return fail(c, 400, 'snippet body must be a JSON object');
    const record = sanitizeBody(body, name);
    if (typeof record === 'string') return fail(c, 400, record);
    await writeSnippet(record, dataDir);
    return c.json({ success: true, snippet: record });
  });

  app.patch('/api/config/snippets/:name', async (c) => {
    const name = c.req.param('name');
    const refused = nameGuard(c, name); if (refused !== null) return refused;
    const stored = await resolveStoredName(name, dataDir);
    if (stored === null) return fail(c, 404, 'snippet not found');
    const existing = await readSnippet(stored, dataDir);
    if (existing === null) return fail(c, 404, 'snippet not found');
    const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
    if (body === null) return fail(c, 400, 'snippet body must be a JSON object');
    // The STORED name leads the merge (and the write): a URL spelled with
    // different case must patch the entry in place, not retitle the file.
    const record = sanitizeBody({ ...existing, ...body }, stored);
    if (typeof record === 'string') return fail(c, 400, record);
    await writeSnippet(record, dataDir);
    return c.json({ success: true, snippet: record });
  });

  app.delete('/api/config/snippets/:name', async (c) => {
    const name = c.req.param('name');
    const refused = nameGuard(c, name); if (refused !== null) return refused;
    const stored = await resolveStoredName(name, dataDir);
    if (stored === null) return fail(c, 404, 'snippet not found');
    const removed = await deleteSnippet(stored, dataDir);
    if (!removed) return fail(c, 404, 'snippet not found');
    return c.json({ success: true });
  });
}
