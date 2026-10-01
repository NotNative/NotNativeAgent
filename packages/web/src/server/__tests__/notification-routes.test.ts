// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as uiAuth from '../lib/auth/ui-auth.ts';
import { NotificationSessions } from '../notifications/session-state.ts';
import { createNotificationRoutes } from '../notifications/routes.ts';
import { PushBadges } from '../push/badge-state.ts';
import type { QueueEnvelope } from '../queue/queue-feed.ts';

const authRoot = mkdtempSync(join(tmpdir(), 'nnd-notification-auth-'));
afterAll(() => rmSync(authRoot, { recursive: true, force: true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  let now = 1000;
  const fetch = vi.fn(async (path: string) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }, { id: 's2' }] : {}));
  const sessions = new NotificationSessions(() => now, (path) => path === '/v1/nnd/pending' ? Promise.resolve(new Response(null, { status: 404 })) : fetch(path)); const badges = new PushBadges();
  const app = createNotificationRoutes({ sessions, badges, owner: (request) => request.headers.get('x-owner') });
  const call = (path: string, owner = 'a', body?: unknown) => app.request(path, { headers: { 'x-owner': owner },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const emit = (type: string, properties: Record<string, unknown>) => sessions.observe({ payload: { id: `event-${now++}`, type, properties } });
  return { sessions, badges, app, call, fetch, emit, tick: (amount: number) => { now += amount; } };
}

it('retains owned active archived sessions present only in the status index and prunes them when no longer covered', async () => {
  const item = fixture();
  item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : { archived: { type: 'busy' } }));
  expect(await (await item.call('/api/sessions/archived/status')).json()).toMatchObject({ sessionId: 'archived', status: 'busy' });
  expect(await (await item.call('/api/session-activity')).json()).toMatchObject({ archived: { type: 'busy' } });
  item.tick(2000); item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : {}));
  expect((await item.call('/api/sessions/archived/status')).status).toBe(404);
});

it('expires a URL-authenticated stream even while its parent session remains valid', async () => {
  let now = 100_000; const item = fixture();
  const auth = new uiAuth.UiAuthController({ dataDir: join(authRoot, 'url'), now: () => now, resolvePassword: () => 'password', urlTokenTtlMs: 1000 });
  vi.spyOn(uiAuth, 'getUiAuthController').mockReturnValue(auth);
  const parent = auth.issueSessionToken(60_000); const url = auth.storeUrlToken(parent.token);
  const app = createNotificationRoutes({ sessions: item.sessions, badges: item.badges });
  const response = await app.request(`/api/notifications/stream?oc_url_token=${url.token}`);
  expect(response.status).toBe(200); const reader = response.body!.getReader(); await reader.read();
  now += 1001; expect(auth.requireSessionCookie(new Headers({ cookie: `oc_ui_session=${parent.token}` }))).toBe(true);
  item.sessions.publish({ type: 'notnative:notification', properties: { body: 'private' } });
  expect((await reader.read()).done).toBe(true); await reader.cancel();
});

it('rejects an expired credential after awaited snapshot loading without committing a receipt', async () => {
  let now = 100_000; const auth = new uiAuth.UiAuthController({ dataDir: join(authRoot, 'write'), now: () => now, resolvePassword: () => 'password' });
  vi.spyOn(uiAuth, 'getUiAuthController').mockReturnValue(auth);
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.fn(async (path: string) => { await hold; return Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : {}); });
  const sessions = new NotificationSessions(() => now, (path) => path === '/v1/nnd/pending' ? Promise.resolve(new Response(null, { status: 404 })) : fetch(path));
  const app = createNotificationRoutes({ sessions, badges: new PushBadges() }); const credential = auth.issueSessionToken(1000);
  const pending = app.request('/api/sessions/s1/view', { method: 'POST', headers: { cookie: `oc_ui_session=${credential.token}` }, body: '{}' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); now += 1001; release();
  expect((await pending).status).toBe(401); expect(sessions.snapshot('unused').attentionSessions.s1).toMatchObject({ isViewed: false });
});

it('orders completion and read markers within one millisecond and keeps actively viewed completions read', async () => {
  const fetch = vi.fn(async (path: string) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : {}));
  const sessions = new NotificationSessions(() => 1000, (path) => path === '/v1/nnd/pending' ? Promise.resolve(new Response(null, { status: 404 })) : fetch(path));
  await sessions.refresh(); sessions.receipts.view('a', 's1', true, {}); sessions.receipts.view('a', 's1', false, {});
  const emit = (type: string) => sessions.observe({ payload: { id: type, type: 'session.status', properties: { sessionID: 's1', status: { type } } } });
  emit('busy'); emit('idle'); expect(sessions.attention('a', 's1')?.needsAttention).toBe(true);
  sessions.receipts.view('a', 's1', true, {}, sessions.get('s1')!.completedRevision);
  emit('busy'); emit('idle'); sessions.receipts.view('a', 's1', false, {});
  expect(sessions.attention('a', 's1')?.needsAttention).toBe(false);
  fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : { s1: { type: 'busy' } }));
  await sessions.refresh(true);
  fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : {}));
  await sessions.refresh(true); expect(sessions.attention('a', 's1')?.needsAttention).toBe(true);
});

it('streams owner-specific unread attention and broadcasts receipt changes to other tabs', async () => {
  const item = fixture(); await item.sessions.refresh();
  item.emit('session.status', { sessionID: 's1', status: { type: 'busy' } }); item.emit('session.idle', { sessionID: 's1' });
  const readers = await Promise.all(['a', 'b'].map(async (owner) => {
    const response = await item.call('/api/notifications/stream', owner); const reader = response.body!.getReader(); await reader.read(); return reader;
  }));
  item.sessions.publishStatus('s1');
  for (const reader of readers) expect(JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)).properties.needsAttention).toBe(true);
  await item.call('/api/sessions/s1/view', 'a', {});
  expect(JSON.parse(new TextDecoder().decode((await readers[0]!.read()).value).slice(6)).properties).toMatchObject({ needsAttention: false, isViewed: true });
  expect(JSON.parse(new TextDecoder().decode((await readers[1]!.read()).value).slice(6)).properties).toMatchObject({ needsAttention: true, isViewed: false });
  await Promise.all(readers.map((reader) => reader.cancel()));
});

it('preserves retry metadata and status-change time across polling and marks restored pending coverage', async () => {
  const item = fixture(); await item.sessions.refresh();
  item.emit('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 2, message: 'waiting', next: 2000 } });
  const changed = item.sessions.attention('a', 's1')!.lastStatusChangeAt;
  item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1', metadata: { nnd: { attention: { kind: 'needs_input' } } } }]
    : { s1: { type: 'retry', attempt: 3, message: 'again', next: 4000 } }));
  item.tick(2000); const status = await (await item.call('/api/sessions/status')).json() as Record<string, unknown>;
  expect(status).toMatchObject({ sessions: { s1: { status: 'retry', metadata: { attempt: 3, message: 'again', next: 4000 } } }, pendingCoverage: 'live-events-only' });
  expect(item.sessions.attention('a', 's1')).toMatchObject({ lastStatusChangeAt: changed, needsAttention: true });
  await item.call('/api/sessions/s1/view', 'a', {});
  expect(item.sessions.attention('a', 's1')?.needsAttention).toBe(true);
});

it('returns validation errors for malformed receipts and does not acknowledge a view', async () => {
  const item = fixture();
  expect((await item.call('/api/sessions/s1/view', 'a', { clientId: 'bad identity', sequence: 1 })).status).toBe(400);
  expect((await item.call('/api/sessions/s1/view', 'a', { clientId: 'one', sequence: -1 })).status).toBe(400);
  expect(item.sessions.attention('a', 's1')?.isViewed).toBe(false);
});

it('round-trips prototype-shaped session ids and does not fabricate inherited sessions', async () => {
  const item = fixture();
  item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: '__proto__' }] : {}));
  expect(await (await item.call('/api/sessions/status')).json()).toMatchObject({ sessions: { ['__proto__']: { status: 'idle' } } });
  expect((await item.call('/api/sessions/__proto__/status')).status).toBe(200);
  expect((await item.call('/api/sessions/constructor/status')).status).toBe(404);
  item.tick(2000); item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's1' }, {}] : {}));
  expect((await item.call('/api/sessions/status')).status).toBe(503);
  expect(item.sessions.get('__proto__')).toBeDefined();
});

it('seeds real NNA states, updates live activity, and retains unresolved blockers after viewing', async () => {
  const item = fixture();
  expect(await (await item.call('/api/sessions/snapshot')).json()).toMatchObject({ statusSessions: { s1: { status: 'idle' } } });
  item.emit('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 2, message: 'waiting', next: 2000 } });
  expect(await (await item.call('/api/sessions/s1/status')).json()).toMatchObject({ status: 'retry', metadata: { attempt: 2 } });
  item.emit('question.asked', { sessionID: 's1', id: 'q1', questions: [{ question: 'Choose' }] });
  item.badges.mark('a', 's1'); item.badges.mark('b', 's1');
  const viewed = await item.call('/api/sessions/s1/view', 'a', { clientId: 'tab-a', sequence: 1 });
  expect(await viewed.json()).toMatchObject({ success: true, viewed: true, badge: { count: 0 } });
  expect(item.badges.snapshot('b').count).toBe(1);
  expect(await (await item.call('/api/sessions/s1/attention')).json()).toMatchObject({ needsAttention: true, isViewed: true });
  expect(await (await item.call('/api/sessions/status')).json()).toMatchObject({ pending: { s1: { forms: [{ id: 'q1' }] } } });
  item.emit('question.replied', { sessionID: 's1', id: 'q1' });
  expect(await (await item.call('/api/sessions/s1/attention')).json()).toMatchObject({ needsAttention: false });
});

it('aggregates tab views, rejects delayed visible writes, expires crashed clients and records sends', async () => {
  const item = fixture(); await item.sessions.refresh();
  await item.call('/api/sessions/s1/view', 'a', { clientId: 'one', sequence: 1 });
  await item.call('/api/sessions/s1/view', 'a', { clientId: 'two', sequence: 1 });
  await item.call('/api/sessions/s1/unview', 'a', { clientId: 'one', sequence: 3 });
  expect(item.sessions.attention('a', 's1')?.isViewed).toBe(true);
  await item.call('/api/sessions/s1/unview', 'a', { clientId: 'two', sequence: 2 });
  item.badges.mark('a', 's1');
  await item.call('/api/sessions/s1/view', 'a', { clientId: 'one', sequence: 2 });
  expect(item.sessions.attention('a', 's1')?.isViewed).toBe(false); expect(item.badges.snapshot('a').count).toBe(1);
  await item.call('/api/sessions/s1/message-sent', 'a', {});
  expect(item.sessions.attention('a', 's1')?.lastUserMessageAt).toBeGreaterThan(0); expect(item.badges.snapshot('a').count).toBe(0);
  item.sessions.receipts.view('a', 's1', true, { clientId: 'one', sequence: 4 }); item.tick(30_000);
  expect(item.sessions.attention('a', 's1')?.isViewed).toBe(false);
});

it('fails closed on missing sessions, malformed snapshots and a racing delete, and removes old scope', async () => {
  const item = fixture();
  expect((await item.call('/api/sessions/unknown/view', 'a', {})).status).toBe(404);
  item.tick(2000); item.fetch.mockImplementation(async () => Response.json('invalid'));
  expect((await item.call('/api/sessions/status')).status).toBe(503);
  item.fetch.mockImplementation(async (path) => {
    if (path === '/session?archived=true') item.emit('session.deleted', { info: { id: 's1' } });
    return Response.json(path === '/session?archived=true' ? [{ id: 's1' }] : {});
  });
  expect((await item.call('/api/sessions/status')).status).toBe(503); expect(item.sessions.get('s1')).toBeUndefined();
  item.fetch.mockImplementation(async (path) => Response.json(path === '/session?archived=true' ? [{ id: 's3' }] : {}));
  await item.sessions.refresh(); expect(item.sessions.get('s2')).toBeUndefined(); expect(item.sessions.get('s3')).toBeDefined();
});

it('streams notifications with an opaque owner, heartbeats, cancellation and credential revocation', async () => {
  vi.useFakeTimers(); const item = fixture(); let active = true;
  const app = createNotificationRoutes({ sessions: item.sessions, badges: item.badges, owner: () => active ? 'opaque-owner' : null });
  const abort = new AbortController(); const response = await app.request('/api/notifications/stream', { signal: abort.signal });
  const reader = response.body!.getReader(); const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
  expect(decode((await reader.read()).value)).toContain('"uiToken":"opaque-owner"');
  item.sessions.publish({ type: 'notnative:notification', properties: { body: 'Hello' } });
  expect(decode((await reader.read()).value)).toContain('Hello');
  vi.advanceTimersByTime(20_000); expect(decode((await reader.read()).value)).toContain(':heartbeat');
  active = false; vi.advanceTimersByTime(20_000); expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0); abort.abort();
});

it('closes a slow consumer rather than keeping an unbounded stream queue', async () => {
  const item = fixture(); const response = await item.call('/api/notifications/stream');
  for (let index = 0; index < 100; index++) item.sessions.publish({ type: 'notnative:notification', properties: { index } });
  const reader = response.body!.getReader(); let count = 0;
  while (!(await reader.read()).done) count++;
  expect(count).toBeLessThanOrEqual(65); await reader.cancel();
});
