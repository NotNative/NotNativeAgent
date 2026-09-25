// SPDX-License-Identifier: Apache-2.0
/** Objective-file API (§B.1), registered behind the global /api auth gate. */
import type { Hono } from 'hono';
import { ObjectiveInputError, ObjectiveStore } from './objective-store.ts';
import { isGoalFileSessionId } from './goal-payload.ts';

const MAX_BODY_BYTES = 32 * 1024;

function failure(error: unknown): Response {
  if (error instanceof ObjectiveInputError) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: 'Objective storage failed' }, { status: 500 });
}

export function registerObjectiveRoutes(app: Hono, store = new ObjectiveStore()): void {
  app.get('/api/goals/objective/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    if (!isGoalFileSessionId(id)) return failure(new ObjectiveInputError('Invalid session id'));
    try {
      const content = await store.read(id, c.req.query('key') ?? '');
      return content === null ? c.json({ error: 'objective not found' }, 404) : c.json({ content });
    } catch (error) { return failure(error); }
  });

  app.put('/api/goals/objective/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    if (!isGoalFileSessionId(id)) return failure(new ObjectiveInputError('Invalid session id'));
    const length = Number(c.req.header('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return c.json({ error: 'Payload too large' }, 413);
    let raw: string;
    try { raw = await c.req.text(); } catch { return c.json({ error: 'Body read failed' }, 400); }
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return c.json({ error: 'Payload too large' }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.json({ error: 'Body must be JSON' }, 400); }
    const content = (body as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') return c.json({ error: 'Objective content is required' }, 400);
    try {
      const key = await store.write(id, content);
      return c.json({ ok: true, key });
    } catch (error) { return failure(error); }
  });

  app.delete('/api/goals/objective/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    if (!isGoalFileSessionId(id)) return failure(new ObjectiveInputError('Invalid session id'));
    try {
      await store.remove(id, c.req.query('key') ?? '');
      return c.json({ ok: true });
    } catch (error) { return failure(error); }
  });
}
