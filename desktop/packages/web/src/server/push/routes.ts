// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { Hono } from 'hono';
import { ENV } from '../env.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { pushEndpoint, pushSubscription } from './subscription-schema.ts';
import { PushStoreError, PushSubscriptionStore } from './subscription-store.ts';
import { PushVisibility } from './visibility.ts';
import { pushAuthorityActive, pushGrant, type PushAuthority } from './authority.ts';
import { PushBadges } from './badge-state.ts';
import { pushRegistrationOrigin } from './registration-origin.ts';
import { recordPublicOriginIfUnset } from '../lib/settings-store.ts';
type PushRouteApp = Hono<{ Variables: { pushOwner: string; pushAuthority: PushAuthority | undefined } }>;

export function pushCredentialOwner(request: Request): string | null {
  const grant = getUiAuthController().authenticate(request.headers, new URL(request.url), request.method, false);
  return grant.ok ? pushGrant(grant)?.owner ?? null : null;
}

export function createPushRoutes(options: { store?: PushSubscriptionStore; visibility?: PushVisibility; badges?: PushBadges; owner?: (request: Request) => string | null; now?: () => number } = {}) {
  const app = new Hono<{ Variables: { pushOwner: string; pushAuthority: PushAuthority | undefined } }>();
  const store = options.store ?? new PushSubscriptionStore(join(ENV.dataDir, 'push-subscriptions.json'));
  const now = options.now ?? Date.now;
  const visibility = options.visibility ?? new PushVisibility(now);
  const badges = options.badges ?? new PushBadges();
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
    const origin = pushRegistrationOrigin(body?.origin, context.req.raw);
    entry.authority = context.get('pushAuthority');
    await store.subscribe(entry);
    if (origin) await recordPublicOriginIfUnset(origin, () => pushAuthorityActive(entry.authority));
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
    return { ok: true, ...(visibility.visible(context.get('pushOwner')) ? { badge: badges.clear(context.get('pushOwner')) } : {}) };
  }));
  registerBadgeRoutes(app, badges);
  app.get('/api/push/visibility', (context) => {
    return Response.json({ ok: true, visible: visibility.visible(context.get('pushOwner')) });
  });
  return app;
}

function registerBadgeRoutes(app: PushRouteApp, badges: PushBadges): void {
  app.get('/api/push/badge', (context) => context.json({ ok: true, badge: badges.snapshot(context.get('pushOwner')) }));
  app.post('/api/push/badge/reset', async (context) => guarded(async () => {
    const body = await readJsonBodyBounded(context.req.raw, 1024);
    const session = body?.sessionId;
    if (typeof session !== 'string' || !session || session.length > 256 || session.trim() !== session || /[\u0000-\u001f\u007f]/u.test(session)
      || (body?.reason !== 'view' && body?.reason !== 'message-sent')) throw new PushStoreError('Invalid badge reset', 400);
    return { ok: true, badge: badges.clear(context.get('pushOwner'), session) };
  }));
}

async function guarded(operation: () => Promise<unknown>): Promise<Response> {
  try { return Response.json(await operation()); }
  catch (error) { return Response.json({ error: error instanceof PushStoreError ? error.message : 'Push storage failed' },
    { status: error instanceof PushStoreError ? error.status : 503 }); }
}
