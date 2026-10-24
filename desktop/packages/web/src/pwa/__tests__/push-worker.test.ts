// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8');

function worker(cache?: { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response) => Promise<void> }) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const self = {
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
    location: { origin: 'https://nnd.example' },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined) },
    clients: { claim: vi.fn().mockResolvedValue(undefined), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(null) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    navigator: { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) },
    caches: cache ? { open: async () => cache } : undefined,
  };
  runInNewContext(source, { self, URL, Response });
  async function dispatch(name: string, fields: Record<string, unknown> = {}) {
    let pending: Promise<unknown> | undefined;
    handlers.get(name)!({ ...fields, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { self, handlers, dispatch };
}

describe('shipped push service worker', () => {
  it('rejects a second window retired-epoch reset after restart while allowing an intentional instance return', async () => {
    const { self, dispatch } = worker();
    const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const c = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const report = (epoch: string, runtimeOrigin: string, count: number, window: string) => dispatch('message', {
      source: { url: `https://nnd.example/${window}` }, data: { type: 'NOTNATIVE_BADGE_STATE', runtimeOrigin, badge: { epoch, count, revision: 2 } },
    });
    await report(a, 'https://first.example', 0, 'one');
    await dispatch('push', { data: { json: () => ({ badge: { epoch: b, count: 1, revision: 1 } }) } });
    await report(a, 'https://first.example', 3, 'two');
    expect(self.navigator.setAppBadge).toHaveBeenCalledExactlyOnceWith(1);
    await report(c, 'https://second.example', 0, 'one');
    await report(a, 'https://first.example', 3, 'two');
    expect(self.navigator.setAppBadge).toHaveBeenCalledOnce();
    await report(b, 'https://first.example', 0, 'one');
    expect(self.navigator.clearAppBadge).toHaveBeenCalledTimes(3);
  });
  it('persists reset revisions so delayed pushes cannot revive unread badges after worker restart', async () => {
    const saved = new Map<string, Response>();
    const cache = { match: async (key: string) => saved.get(key)?.clone(), put: async (key: string, response: Response) => { saved.set(key, response); } };
    const first = worker(cache); const epoch = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await first.dispatch('push', { data: { json: () => ({ badge: { count: 2, epoch, revision: 2 } }) } });
    expect(first.self.navigator.setAppBadge).toHaveBeenCalledWith(2);
    await first.dispatch('message', { source: { url: 'https://nnd.example/' }, data: { type: 'NOTNATIVE_BADGE_STATE', badge: { count: 0, epoch, revision: 3 } } });
    expect(first.self.navigator.clearAppBadge).toHaveBeenCalledOnce();
    const restarted = worker(cache);
    await restarted.dispatch('push', { data: { json: () => ({ badge: { count: 2, epoch, revision: 2 } }) } });
    expect(restarted.self.navigator.setAppBadge).not.toHaveBeenCalled();
    expect(restarted.self.registration.showNotification).toHaveBeenCalledOnce();
  });
  it('accepts a server restart but ignores retired epochs and foreign window resets', async () => {
    const { self, dispatch } = worker();
    const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const push = (epoch: string, revision: number) => dispatch('push', { data: { json: () => ({ badge: { count: 1, epoch, revision } }) } });
    await push(a, 20); await push(b, 1); await push(a, 21);
    expect(self.navigator.setAppBadge).toHaveBeenCalledTimes(2);
    await dispatch('message', { source: { url: 'https://other.example/' }, data: { type: 'NOTNATIVE_BADGE_STATE', badge: { count: 0, epoch: b, revision: 2 } } });
    expect(self.navigator.clearAppBadge).not.toHaveBeenCalled();
    self.navigator.setAppBadge.mockRejectedValue(new Error('denied'));
    await push(b, 3); expect(self.registration.showNotification).toHaveBeenCalledTimes(4);
  });
  it('preserves session identity and constructs an encoded local route', async () => {
    const { self, dispatch } = worker();
    await dispatch('push', { data: { json: () => ({ sessionId: 's/a?token=x', url: 'https://attacker.example' }) } });
    expect(self.registration.showNotification.mock.calls[0]?.[1].data).toEqual({ sessionId: 's/a?token=x' });
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 's/a?token=x' } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://nnd.example/?session=s%2Fa%3Ftoken%3Dx');
  });
  it('focuses an exact session route and preserves other drafts', async () => {
    const { self, dispatch } = worker();
    const target = { url: 'https://nnd.example/?session=s1', focus: vi.fn().mockResolvedValue(undefined) };
    const other = { url: 'https://nnd.example/', focus: vi.fn() };
    self.clients.matchAll.mockResolvedValue([other, target]);
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 's1' } } });
    expect(target.focus).toHaveBeenCalledOnce(); expect(other.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
  it.each([' s1', 's1\n', 'x'.repeat(257), {}, ''])('falls back for invalid session %s', async (sessionId) => {
    const { self, dispatch } = worker();
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { sessionId } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://nnd.example/');
  });
  it('displays bounded text without trusting navigation or image fields', async () => {
    const { self, dispatch, handlers } = worker();
    await dispatch('push', { data: { json: () => ({ title: 'x'.repeat(200), body: 'hello\nworld', tag: 't'.repeat(300), url: 'https://attacker.example', icon: 'https://attacker.example/pixel' }) } });
    expect(self.registration.showNotification).toHaveBeenCalledWith('x'.repeat(120), { body: 'hello world', tag: 't'.repeat(200) });
    expect(handlers.has('fetch')).toBe(false);
  });

  it.each([null, 4, [], { title: {}, body: false }, undefined])('shows a fallback for invalid payload %s', async (payload) => {
    const { self, dispatch } = worker();
    await dispatch('push', { data: { json: () => payload } });
    expect(self.registration.showNotification).toHaveBeenCalledWith('NotNativeDesktop', { body: 'There is new activity in your workspace.' });
  });

  it('shows a fallback for missing and malformed JSON', async () => {
    const { self, dispatch } = worker();
    await dispatch('push');
    await dispatch('push', { data: { json: () => { throw new Error('invalid JSON'); } } });
    expect(self.registration.showNotification).toHaveBeenCalledTimes(2);
  });

  it('focuses an existing clean home window without changing another workspace surface', async () => {
    const { self, dispatch } = worker();
    const other = { url: 'https://nnd.example/?surface=desktop&sessionId=abc', focus: vi.fn() };
    const home = { url: 'https://nnd.example/', focus: vi.fn().mockResolvedValue(undefined) };
    self.clients.matchAll.mockResolvedValue([other, home]);
    const close = vi.fn();
    await dispatch('notificationclick', { notification: { close, data: { url: 'https://attacker.example' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(home.focus).toHaveBeenCalledOnce();
    expect(other.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens only the local application when no suitable window survives', async () => {
    const { self, dispatch } = worker();
    self.clients.matchAll.mockResolvedValue([
      { url: 'https://other.example/', focus: vi.fn() },
      { url: 'https://nnd.example/?nn_url_token=secret', focus: vi.fn() },
      { url: 'https://nnd.example/', focus: vi.fn().mockRejectedValue(new Error('closed')) },
    ]);
    await dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://nnd.example/');
  });

  it('retains user-driven update activation and client claiming', async () => {
    const { self, dispatch } = worker();
    await dispatch('message', { data: { type: 'other' } });
    expect(self.skipWaiting).not.toHaveBeenCalled();
    await dispatch('message', { source: { type: 'window', url: 'https://other.example/' }, data: { type: 'NOTNATIVE_ACTIVATE_UPDATE' } });
    await dispatch('message', { source: { type: 'worker', url: 'https://nnd.example/' }, data: { type: 'NOTNATIVE_ACTIVATE_UPDATE' } });
    await dispatch('message', { data: { type: 'NOTNATIVE_ACTIVATE_UPDATE' } });
    expect(self.skipWaiting).not.toHaveBeenCalled();
    await dispatch('message', { source: { type: 'window', url: 'https://nnd.example/' }, data: { type: 'NOTNATIVE_ACTIVATE_UPDATE' } });
    expect(self.skipWaiting).toHaveBeenCalledOnce();
    await dispatch('activate');
    expect(self.clients.claim).toHaveBeenCalledOnce();
  });
});
