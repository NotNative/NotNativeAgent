// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { startSessionBadges } from '../session-badges.ts';
import { applyBrowserBadge } from '../browser-badge.ts';
import { startPushPresence } from '../push-presence.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import type { PushApi } from '../api/push-types.ts';

const badge = { count: 0, epoch: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: 2 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useSessionViewStore.getState().setCurrentSession(null); });

it('keeps an earlier successful reset usable when a newer reset fails', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  let finish!: (value: typeof badge) => void;
  const resetBadge = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockRejectedValueOnce(new Error('offline'));
  const postMessage = vi.fn(); vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
  const stop = startSessionBadges({ resetBadge } as unknown as PushApi, () => true);
  window.dispatchEvent(new CustomEvent('notnative:message-sent', { detail: { sessionId: 's1' } }));
  window.dispatchEvent(new CustomEvent('notnative:message-sent', { detail: { sessionId: 's2' } }));
  await Promise.resolve(); finish(badge); await Promise.resolve();
  expect(postMessage).toHaveBeenCalledOnce(); stop();
});

it('drops a delayed pre-restart presence response after a newer session reset confirms another epoch', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  let presence!: (value: { ok: true; badge: typeof badge }) => void;
  let reset!: (value: typeof badge) => void;
  const api = { setVisibility: vi.fn(() => new Promise((resolve) => { presence = resolve; })),
    resetBadge: vi.fn(() => new Promise((resolve) => { reset = resolve; })) } as unknown as PushApi;
  const postMessage = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
  const stopPresence = startPushPresence({ api, clientId: 'client', current: () => true, window, document });
  const stopBadges = startSessionBadges(api, () => true);
  window.dispatchEvent(new CustomEvent('notnative:message-sent', { detail: { sessionId: 's1' } }));
  const newer = { ...badge, epoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', revision: 1 };
  reset(newer); await Promise.resolve();
  presence({ ok: true, badge: { ...badge, count: 3, revision: 20 } }); await Promise.resolve();
  expect(postMessage).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'NOTNATIVE_BADGE_STATE', badge: newer });
  stopBadges(); stopPresence();
});

it('allows a focused session reset to clear badges after a later hidden beacon', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let reset!: (value: typeof badge) => void;
  const setVisibility = vi.fn().mockResolvedValue({ ok: true });
  const api = { setVisibility, resetBadge: vi.fn(() => new Promise((resolve) => { reset = resolve; })) } as unknown as PushApi;
  const postMessage = vi.fn(); vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
  useSessionViewStore.getState().setCurrentSession('s1');
  const stopPresence = startPushPresence({ api, clientId: 'client', current: () => true, window, document });
  const stopBadges = startSessionBadges(api, () => true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false); window.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(setVisibility.mock.calls.some(([state]) => !state.visible)).toBe(true));
  reset(badge); await Promise.resolve(); expect(postMessage).toHaveBeenCalledOnce();
  stopBadges(); stopPresence();
});

it('orders window badges before the first worker claim and ignores older reset responses', async () => {
  let finish!: () => void;
  const order: string[] = [];
  const target = { setAppBadge: vi.fn(async () => { order.push('set'); await new Promise<void>((resolve) => { finish = resolve; }); }),
    clearAppBadge: vi.fn(async () => { order.push('clear'); }) } as unknown as Navigator;
  applyBrowserBadge({ ...badge, count: 3, revision: 3 }, target);
  await Promise.resolve();
  applyBrowserBadge({ ...badge, revision: 5 }, target);
  applyBrowserBadge({ ...badge, count: 2, revision: 4 }, target);
  expect(order).toEqual(['set']); finish();
  await vi.waitFor(() => expect(order).toEqual(['set', 'clear']));
});

it('resets focused session views and confirmed sends, and releases listeners on stop', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const resetBadge = vi.fn().mockResolvedValue(badge);
  useSessionViewStore.getState().setCurrentSession('s1');
  const stop = startSessionBadges({ resetBadge } as unknown as PushApi, () => true);
  expect(resetBadge).toHaveBeenCalledWith('s1', 'view');
  useSessionViewStore.getState().setCurrentSession('s2');
  window.dispatchEvent(new CustomEvent('notnative:message-sent', { detail: { sessionId: 's1' } }));
  expect(resetBadge).toHaveBeenCalledWith('s2', 'view'); expect(resetBadge).toHaveBeenCalledWith('s1', 'message-sent');
  stop(); const count = resetBadge.mock.calls.length;
  window.dispatchEvent(new Event('focus')); useSessionViewStore.getState().setCurrentSession('s3');
  expect(resetBadge).toHaveBeenCalledTimes(count);
  await Promise.resolve();
});

it('ignores stale runtime responses and contains a closing service worker', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  let resolve!: (value: typeof badge) => void; let current = true;
  const resetBadge = vi.fn(() => new Promise<typeof badge>((done) => { resolve = done; }));
  const postMessage = vi.fn();
  const target = { serviceWorker: { controller: { postMessage } } } as unknown as Navigator;
  vi.stubGlobal('navigator', target);
  const stop = startSessionBadges({ resetBadge } as unknown as PushApi, () => current);
  window.dispatchEvent(new CustomEvent('notnative:message-sent', { detail: { sessionId: 's1' } }));
  current = false; resolve(badge); await Promise.resolve(); expect(postMessage).not.toHaveBeenCalled(); stop();
  postMessage.mockImplementation(() => { throw new Error('closing'); });
  expect(() => applyBrowserBadge(badge, target)).not.toThrow();
});
