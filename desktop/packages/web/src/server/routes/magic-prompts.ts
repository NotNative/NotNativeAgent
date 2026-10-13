// SPDX-License-Identifier: Apache-2.0
/** Magic-prompt config routes (doc 03 §5.31). */
import { Hono, type Context } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import {
  deleteAllMagicPromptOverrides,
  deleteMagicPromptOverride,
  readMagicPrompts,
  writeMagicPromptOverride,
} from '../magic-prompts/prompt-store.ts';

const BODY_MAX = JSON.stringify({ text: 'x'.repeat(200_000), ignored: true }).length;

function badRequest(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

async function writeHandler(c: Context, idOrUndefined: string | undefined, dataDir: string | undefined): Promise<Response> {
  const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
  if (body === null) return badRequest(c, 'body must be a JSON object');
  const requested = idOrUndefined ?? body.id;
  const id = typeof requested === 'string' ? requested : '';
  const text = body.text;
  try {
    const state = await writeMagicPromptOverride(id, typeof text === 'string' ? text : '', dataDir);
    return c.json(state);
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : 'invalid magic prompt');
  }
}

export function registerMagicPromptRoutes(app: Hono, options: { dataDir?: string } = {}): void {
  const dataDir = options.dataDir;

  app.get('/api/magic-prompts', async (c) => c.json(await readMagicPrompts(dataDir)));

  app.put('/api/magic-prompts/:id', (c) => writeHandler(c, c.req.param('id'), dataDir));

  app.delete('/api/magic-prompts/:id', async (c) => {
    try {
      const state = await deleteMagicPromptOverride(c.req.param('id'), dataDir);
      return state === null ? c.json({ error: 'magic prompt not found' }, 404) : c.json(state);
    } catch (error) {
      return badRequest(c, error instanceof Error ? error.message : 'invalid magic prompt');
    }
  });

  app.delete('/api/magic-prompts', async (c) => c.json(await deleteAllMagicPromptOverrides(dataDir)));
}
