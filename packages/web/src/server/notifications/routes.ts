// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { pushGrant } from '../push/authority.ts';
import { PushStoreError } from '../push/subscription-store.ts';
import type { PushBadges } from '../push/badge-state.ts';
import { notificationSessionId } from './session-projection.ts';
import { NotificationSessions } from './session-state.ts';
import { notificationStream } from './stream.ts';

type NotificationApp = Hono<{ Variables: { notificationOwner: string; notificationActive: () => boolean } }>;
export function createNotificationRoutes(input: { sessions: NotificationSessions; badges: PushBadges; owner?: (request: Request) => string | null }): NotificationApp {
  const app: NotificationApp = new Hono();
  for (const path of ['/api/sessions/*', '/api/session-activity', '/api/notifications/stream']) app.use(path, async (c, next) => {
    const auth = input.owner ? null : getUiAuthController().authenticate(c.req.raw.headers, new URL(c.req.url), c.req.method, c.req.path === '/api/notifications/stream');
    if (auth && !auth.ok) return c.json({ error: 'UI authentication required' }, 401);
    const grant = auth?.ok ? pushGrant(auth) : null;
    const owner = input.owner ? input.owner(c.req.raw) : grant?.owner;
    c.set('notificationOwner', owner ?? '');
    c.set('notificationActive', input.owner ? () => input.owner!(c.req.raw) === owner : () => {
      const current = getUiAuthController().authenticate(c.req.raw.headers, new URL(c.req.url), c.req.method, c.req.path === '/api/notifications/stream');
      return current.ok && (pushGrant(current)?.owner ?? '') === (owner ?? '');
    });
    await next(); c.header('cache-control', c.req.path.endsWith('/stream') ? 'no-cache, no-transform' : 'no-store');
  });
  app.get('/api/notifications/stream', async (c) => {
    const owner = c.get('notificationOwner');
    if (!owner) return c.json({ error: 'Notification stream requires a UI session or client credential' }, 401);
    try { await input.sessions.refresh(); } catch { return c.json({ error: 'NNA session snapshot is unavailable' }, 503); }
    if (!c.get('notificationActive')()) return c.json({ error: 'UI authentication required' }, 401);
    return notificationStream(input.sessions, owner, c.get('notificationActive'), c.req.raw.signal);
  });
  registerNotificationReads(app, input.sessions);
  for (const action of ['view', 'unview', 'message-sent'] as const) app.post(`/api/sessions/:id/${action}`, async (c) => {
    const owner = c.get('notificationOwner'); if (!owner) return c.json({ error: 'Session receipts require a UI session or client credential' }, 401);
    const id = notificationSessionId(c.req.param('id')); if (!id) return c.json({ error: 'Invalid session id' }, 400);
    try {
      await input.sessions.refresh();
      if (!input.sessions.get(id)) return c.json({ error: 'Session not found or no state available', sessionId: id }, 404);
      const body = c.req.raw.body ? await readJsonBodyBounded(c.req.raw, 1024) : {};
      if (!body) return c.json({ error: 'Invalid session receipt' }, 400);
      if (!c.get('notificationActive')()) return c.json({ error: 'UI authentication required' }, 401);
      const revision = input.sessions.get(id)!.completedRevision;
      if (action === 'message-sent') input.sessions.receipts.sent(owner, id, revision);
      else input.sessions.receipts.view(owner, id, action === 'view', body, revision);
      const badge = action === 'unview' ? undefined : action === 'view' && !input.sessions.receipts.viewed(owner, id)
        ? input.badges.snapshot(owner) : input.badges.clear(owner, id);
      input.sessions.publishStatus(id);
      return c.json({ success: true, sessionId: id, ...(action === 'message-sent' ? { messageSent: true } : { viewed: action === 'view' }), ...(badge ? { badge } : {}) });
    } catch (error) {
      if (error instanceof PushStoreError && (error.status === 400 || error.status === 409)) return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Session receipt could not be confirmed' }, 503);
    }
  });
  return app;
}

function registerNotificationReads(app: NotificationApp, sessions: NotificationSessions): void {
  for (const [path, section] of [['/api/session-activity', 'activity'], ['/api/sessions/status', 'statusSessions'],
    ['/api/sessions/attention', 'attentionSessions'], ['/api/sessions/snapshot', 'snapshot']] as const) app.get(path, async (c) => {
    try {
      await sessions.refresh(); const snapshot = sessions.snapshot(c.get('notificationOwner'));
      if (!c.get('notificationActive')()) return c.json({ error: 'UI authentication required' }, 401);
      if (section === 'activity') return c.json(snapshot.activity);
      if (section === 'snapshot') return c.json({ statusSessions: snapshot.statusSessions, attentionSessions: snapshot.attentionSessions,
        pendingCoverage: snapshot.pendingCoverage, serverTime: snapshot.serverTime });
      return c.json({ sessions: snapshot[section], ...(section === 'statusSessions' ? { pending: snapshot.pending, pendingCoverage: snapshot.pendingCoverage } : {}), serverTime: snapshot.serverTime });
    } catch { return c.json({ error: 'NNA session snapshot is unavailable' }, 503); }
  });
  for (const section of ['status', 'attention'] as const) app.get(`/api/sessions/:id/${section}`, async (c) => {
    const id = notificationSessionId(c.req.param('id')); if (!id) return c.json({ error: 'Invalid session id' }, 400);
    try {
      await sessions.refresh(); const snapshot = sessions.snapshot(c.get('notificationOwner'));
      if (!c.get('notificationActive')()) return c.json({ error: 'UI authentication required' }, 401);
      const state = (section === 'status' ? snapshot.statusSessions : snapshot.attentionSessions)[id];
      return state ? c.json({ sessionId: id, ...(state as Record<string, unknown>) }) : c.json({ sessionId: id, error: 'Session not found or no state available' }, 404);
    } catch { return c.json({ error: 'NNA session snapshot is unavailable' }, 503); }
  });
}
