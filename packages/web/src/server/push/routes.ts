// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { Hono } from 'hono';
import { ENV } from '../env.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { pushEndpoint, pushSubscription } from './subscription-schema.ts';
import { PushStoreError, PushSubscriptionStore } from './subscription-store.ts';
import { PushVisibility } from './visibility.ts';
import { pushGrant, type PushAuthority } from './authority.ts';

export function pushCredentialOwner(request: Request): string | null {
  const grant = getUiAuthController().authenticate(request.headers, new URL(request.url), request.method, false);
  return grant.ok ? pushGrant(grant)?.owner ?? null : null;
}

export function createPushRoutes(options: { store?: PushSubscriptionStore; visibility?: PushVisibility; owner?: (request: Request) => string | null; now?: () => number } = {}) {
  const app = new Hono<{ Variables: { pushOwner: string; pushAuthority: PushAuthority | undefined } }>();
  const store = options.store ?? new PushSubscriptionStore(join(ENV.dataDir, 'push-subscriptions.json'));
  const now = options.now ?? Date.now;
  const visibility = options.visibility ?? new PushVisibility(now);
  app.use('/api/push/*', async (context, next) => {
    await next();
    context.header('cache-control', 'no-store');
  });
  app.get('/api/push/vapid-public-key', async () => guarded(async () => ({ publicKey: await store.publicKey() })));
  app.use('/api/push/*', async (context, next) => {
    const auth = options.owner ? null : getUiAuthController().authenticate(context.req.raw.headers, new URL(context.req.url), context.req.method, false);
    const captured = auth?.ok ? pushGrant(auth) : null;
    const owner = options.owner ? options.owner(context.req.raw) : captured?.owner;
    if (!owner) return Response.json({ error: 'Push registration requires a UI session or client credential' }, { status: 401 });
    context.set('pushOwner', owner);
    context.set('pushAuthority', captured?.authority);
    return next();
  });
  app.post('/api/push/subscribe', async (context) => guarded(async () => {
    const body = await readJsonBodyBounded(context.req.raw, 16_384);
    const entry = pushSubscription(body, context.get('pushOwner'), now());
    if (!entry) throw new PushStoreError('Invalid push subscription', 400);
    entry.authority = context.get('pushAuthority');
    await store.subscribe(entry);
    return { ok: true };
  }));
  app.delete('/api/push/subscribe', async (context) => guarded(async () => {
    const body = await readJsonBodyBounded(context.req.raw, 8_192);
    const endpoint = pushEndpoint(body?.endpoint);
    if (!endpoint) throw new PushStoreError('Invalid push endpoint', 400);
    await store.unsubscribe(context.get('pushOwner'), endpoint);
    return { ok: true };
  }));
  app.post('/api/push/visibility', async (context) => guarded(async () => {
    const body = await readJsonBodyBounded(context.req.raw, 1_024);
    visibility.update(context.get('pushOwner'), body);
    return { ok: true };
  }));
  app.get('/api/push/visibility', (context) => {
    return Response.json({ ok: true, visible: visibility.visible(context.get('pushOwner')) });
  });
  return app;
}

async function guarded(operation: () => Promise<unknown>): Promise<Response> {
  try { return Response.json(await operation()); }
  catch (error) { return Response.json({ error: error instanceof PushStoreError ? error.message : 'Push storage failed' },
    { status: error instanceof PushStoreError ? error.status : 503 }); }
}
