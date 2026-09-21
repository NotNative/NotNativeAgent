// SPDX-License-Identifier: Apache-2.0
/**
 * Message-queue route family (doc 12 §D.5, doc 03 §5.18): all under
 * `/api/message-queue`, authenticated behind the global gate and NEVER on
 * a browser URL-token allowlist. Routing registers BEFORE the generic
 * harness proxy (app.ts registerApiSurfaces region). Body budget: the
 * route family's 50 MiB JSON cap (doc 03 §3) through the shared bounded
 * reader — the harness proxy uses a different cap; NND routes own theirs.
 * Every mutation answers/broadcasts through the runtime (revision bump +
 * persist + `notnative:message-queue.updated` with `session` = directory).
 */
import { Hono, type Context } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { QueueItemValidationError, publicQueueItem } from './queue-item.ts';
import { getMessageQueueRuntime, type MessageQueueRuntime } from './queue-runtime.ts';

export const QUEUE_BODY_MAX_CHARS = 50 * 1024 * 1024; // 50 MiB JSON cap (doc 03 §3)

interface EnqueueBody {
  directory?: unknown;
  item?: unknown;
}

interface OrderBody {
  itemIds?: unknown;
}

interface HoldBody {
  held?: unknown;
  ttlMs?: unknown;
}

function bodyIsObject(body: Record<string, unknown> | null): body is Record<string, unknown> {
  return body !== null && typeof body === 'object';
}

function invalid(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  return readJsonBodyBounded(c.req.raw, QUEUE_BODY_MAX_CHARS);
}

function sessionDirectory(sessionId: string, runtime: MessageQueueRuntime): string {
  // directoryOf, not the snapshot: a memory-only emptied entry (E-09-6) is
  // snapshot-invisible but §D.5 still names its directory in every reply.
  return runtime.store.directoryOf(sessionId) ?? '';
}

async function enqueueHandler(c: Context, runtime: MessageQueueRuntime): Promise<Response> {
  const sessionId = c.req.param('id') ?? '';
  const body = await readBody(c);
  if (!bodyIsObject(body)) return invalid(c, 'message-queue enqueue requires a JSON body within the 50 MiB budget');
  const directory = body.directory;
  if (typeof directory !== 'string' || directory.trim() === '') return invalid(c, 'directory is required');
  const item = body.item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return invalid(c, 'item must be an object');
  try {
    const { revision, itemId } = runtime.enqueueItem(sessionId, directory, item);
    return c.json({ revision, session: directory, itemId });
  } catch (error) {
    if (error instanceof QueueItemValidationError) return invalid(c, error.message);
    return invalid(c, `queued item rejected: ${String(error).slice(0, 200)}`);
  }
}

function takeItemHandler(c: Context, runtime: MessageQueueRuntime): Response {
  const params = c.req.param();
  const sessionId = params.id ?? '';
  const itemId = params.itemId ?? '';
  const outcome = runtime.takeItem(sessionId, itemId);
  if (outcome.kind === 'inFlight') return c.json({ error: 'queued item is in flight' }, 409);
  if (outcome.kind === 'unknown') return c.json({ error: `queued item not found: ${itemId}` }, 404);
  return c.json({
    revision: outcome.revision,
    session: outcome.directory,
    item: { ...outcome.item, preview: publicQueueItem(outcome.item).preview },
  });
}

function takeAllHandler(c: Context, runtime: MessageQueueRuntime): Response {
  const outcome = runtime.takeAllItems(c.req.param('id') ?? '');
  if (outcome.kind === 'unknown') return c.json({ error: 'queued session not found' }, 404);
  return c.json({
    revision: outcome.revision,
    session: outcome.directory,
    items: outcome.items.map((item) => ({ ...item, preview: publicQueueItem(item).preview })),
  });
}

async function orderHandler(c: Context, runtime: MessageQueueRuntime): Promise<Response> {
  const sessionId = c.req.param('id') ?? '';
  const body = await readBody(c);
  if (!bodyIsObject(body)) return invalid(c, 'message-queue reorder requires a JSON body');
  const itemIds = body.itemIds;
  if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== 'string' || id === '')) {
    return invalid(c, 'itemIds must be an array of item ids');
  }
  const outcome = runtime.reorderItems(sessionId, itemIds as string[]);
  if (outcome === 'unknown') return c.json({ error: 'queued session not found' }, 404);
  if (outcome === 'incomplete') return invalid(c, 'itemIds must be a complete permutation of the current queue');
  return c.json({ revision: runtime.currentRevision(), session: sessionDirectory(sessionId, runtime) });
}

function deleteItemHandler(c: Context, runtime: MessageQueueRuntime): Response {
  const params = c.req.param();
  const sessionId = params.id ?? '';
  const itemId = params.itemId ?? '';
  const outcome = runtime.deleteItem(sessionId, itemId);
  if (outcome.kind === 'inFlight') return c.json({ error: 'queued item is in flight' }, 409);
  if (outcome.kind === 'unknown') return c.json({ error: `queued item not found: ${itemId}` }, 404);
  return c.json({ revision: outcome.revision, session: outcome.directory }); // directory-named even on the last item (§D.5)
}

async function holdHandler(c: Context, runtime: MessageQueueRuntime): Promise<Response> {
  const body = await readBody(c);
  if (!bodyIsObject(body)) return invalid(c, 'message-queue hold requires a JSON body');
  if (typeof body.held !== 'boolean') return invalid(c, 'held must be a boolean');
  const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined;
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) return invalid(c, 'ttlMs must be a positive integer');
  const outcome = runtime.setHold(c.req.param('id') ?? '', body.held, ttlMs);
  return c.json(outcome);
}

/** Mount the family; `runtime` stays injectable for tests (the app
 *  registration below lazily builds the production singleton). */
export type QueueRuntimeProvider = () => MessageQueueRuntime;

export function createMessageQueueRoutes(runtimeProvider: MessageQueueRuntime | QueueRuntimeProvider): Hono {
  const resolve = typeof runtimeProvider === 'function' ? runtimeProvider : () => runtimeProvider;
  const app = new Hono();
  app.get('/api/message-queue', (c) => c.json({ revision: resolve().currentRevision(), sessions: resolve().snapshotSessions() }));
  app.post('/api/message-queue/sessions/:id/items', (c) => enqueueHandler(c, resolve()));
  app.post('/api/message-queue/sessions/:id/items/:itemId/take', (c) => takeItemHandler(c, resolve()));
  app.post('/api/message-queue/sessions/:id/take', (c) => takeAllHandler(c, resolve()));
  app.put('/api/message-queue/sessions/:id/order', (c) => orderHandler(c, resolve()));
  app.delete('/api/message-queue/sessions/:id/items/:itemId', (c) => deleteItemHandler(c, resolve()));
  app.delete('/api/message-queue/sessions/:id', (c) => clearSessionHandler(c, resolve()));
  app.put('/api/message-queue/sessions/:id/hold', (c) => holdHandler(c, resolve()));
  return app;
}

function clearSessionHandler(c: Context, runtime: MessageQueueRuntime): Response {
  const outcome = runtime.deleteSessionQueue(c.req.param('id') ?? '');
  if (outcome.kind === 'unknown') return c.json({ error: 'queued session not found' }, 404);
  return c.json({ revision: outcome.revision, session: outcome.directory });
}

/** app.ts wiring (registerApiSurfaces, BEFORE the harness proxy). The
 *  runtime singleton stays LAZY: the feed pump and the file lock belong to
 *  process land (index.ts boots it like the terminal sweep), so an app
 *  router built in a smoke/test process never holds the event loop open. */
export function registerMessageQueueRoutes(app: Hono): void {
  app.route('/', createMessageQueueRoutes(() => getMessageQueueRuntime()));
}
