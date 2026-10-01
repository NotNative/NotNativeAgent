// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8');

function worker() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const self = {
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
    location: { origin: 'https://nnd.example' },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined) },
    clients: { claim: vi.fn().mockResolvedValue(undefined), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(null) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
  };
  runInNewContext(source, { self, URL });
  async function dispatch(name: string, fields: Record<string, unknown> = {}) {
    let pending: Promise<unknown> | undefined;
    handlers.get(name)!({ ...fields, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { self, handlers, dispatch };
}

describe('shipped push service worker', () => {
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
    await dispatch('message', { data: { type: 'NOTNATIVE_ACTIVATE_UPDATE' } });
    expect(self.skipWaiting).toHaveBeenCalledOnce();
    await dispatch('activate');
    expect(self.clients.claim).toHaveBeenCalledOnce();
  });
});
