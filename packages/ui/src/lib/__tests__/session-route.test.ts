// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountSessionRoute, notifySessionRouteNavigation, routeSessionId, sessionNavigationRevision } from '../session-route.ts';
import { harnessClient } from '../nnd/client.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { openInitialSession } from '../../sync/engine-instance.ts';
const runtime = vi.hoisted(() => ({ key: 'local' }));
vi.mock('../runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key }));
vi.mock('../nnd/client.ts', () => ({ harnessClient: { getSession: vi.fn() },
  normalizeDirectory: (value: string) => value.trim().replaceAll('\\', '/').replace(/\/+$/u, '') }));
vi.mock('../../sync/persist-cache.ts', () => ({ persistLastActiveSession: vi.fn() }));
let stop = () => {};
const failure = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); runtime.key = 'local'; window.history.replaceState({}, '', '/');
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '/initial' });
  useGlobalSessionsStore.setState({ directoryOf: {} });
});
afterEach(() => stop());
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
it('opens a cold link in its authenticated directory', async () => {
  window.history.replaceState({}, '', '/?session=s%2Fa');
  vi.mocked(harnessClient.getSession).mockResolvedValue({ data: { id: 's/a', directory: 'D:\\other' } as never });
  stop = mountSessionRoute(failure); await settle();
  expect(harnessClient.getSession).toHaveBeenCalledExactlyOnceWith('s/a', { directory: '' });
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: 's/a', activeDirectory: 'D:/other' });
});
it('uses the global list and adopts later directory moves', () => {
  window.history.replaceState({}, '', '/?session=s1');
  useGlobalSessionsStore.setState({ directoryOf: { s1: '/one' } });
  stop = mountSessionRoute(failure);
  expect(useSessionViewStore.getState().activeDirectory).toBe('/one');
  useGlobalSessionsStore.setState({ directoryOf: { s1: '/two' } });
  expect(useSessionViewStore.getState().activeDirectory).toBe('/two');
  expect(harnessClient.getSession).not.toHaveBeenCalled();
});
it('preserves a filesystem root directory when normalization would remove trailing slashes', async () => {
  window.history.replaceState({}, '', '/?session=s1');
  vi.mocked(harnessClient.getSession).mockResolvedValue({ data: { id: 's1', directory: '/' } as never });
  stop = mountSessionRoute(failure); await settle();
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: 's1', activeDirectory: '/' });
  expect(failure).not.toHaveBeenCalled();
});
it('adopts a directory move that arrives while a cold lookup is pending', async () => {
  window.history.replaceState({}, '', '/?session=s1');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  stop = mountSessionRoute(failure);
  useGlobalSessionsStore.setState({ directoryOf: { s1: '/moved' } });
  finish({ data: { id: 's1', directory: '/old' } } as never); await settle();
  expect(useSessionViewStore.getState().activeDirectory).toBe('/moved');
});
it('preserves an explicit new draft while allowing boot directory hydration', async () => {
  window.history.replaceState({}, '', '/?session=s1');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  stop = mountSessionRoute(failure);
  useSessionViewStore.setState({ activeDirectory: '/boot' });
  expect(window.location.search).toBe('?session=s1');
  useSessionViewStore.setState({ activeDirectory: '/draft' });
  notifySessionRouteNavigation();
  finish({ data: { id: 's1', directory: '/other' } } as never); await settle();
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: null, activeDirectory: '/draft' });
  expect(window.location.search).toBe(''); expect(failure).not.toHaveBeenCalled();
});
it.each(['denied', 'mismatched', 'missing directory'])('preserves selection when resolution is %s', async (kind) => {
  useSessionViewStore.setState({ currentSessionId: 'existing' });
  window.history.replaceState({}, '', '/?session=s1');
  vi.mocked(harnessClient.getSession).mockResolvedValue(kind === 'denied' ? { error: '403' }
    : { data: { id: kind === 'mismatched' ? 'other' : 's1', directory: kind === 'missing directory' ? '' : '/other' } as never });
  stop = mountSessionRoute(failure); await settle();
  expect(useSessionViewStore.getState().currentSessionId).toBe('existing'); expect(failure).toHaveBeenCalledOnce();
});
it.each([{}, ' ', '/bad\npath', 'x'.repeat(4097)])('rejects malformed wire directories %s without throwing', async (directory) => {
  useSessionViewStore.setState({ currentSessionId: 'existing' });
  window.history.replaceState({}, '', '/?session=s1');
  vi.mocked(harnessClient.getSession).mockResolvedValue({ data: { id: 's1', directory } as never });
  stop = mountSessionRoute(failure); await settle();
  expect(useSessionViewStore.getState().currentSessionId).toBe('existing'); expect(failure).toHaveBeenCalledOnce();
});
it.each(['selection', 'runtime', 'unmount', 'pop'])('rejects a pending response after %s changes', async (kind) => {
  window.history.replaceState({}, '', '/?session=s1');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  stop = mountSessionRoute(failure);
  if (kind === 'selection') useSessionViewStore.setState({ currentSessionId: 'user-choice' });
  if (kind === 'runtime') runtime.key = 'remote';
  if (kind === 'unmount') stop();
  if (kind === 'pop') { window.history.replaceState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }
  finish({ data: { id: 's1', directory: '/other' } } as never); await settle();
  expect(useSessionViewStore.getState().currentSessionId).not.toBe('s1');
});
it('serializes selections and restores popstate without rewriting history', () => {
  stop = mountSessionRoute(failure); useSessionViewStore.setState({ currentSessionId: 's/a' });
  expect(window.location.search).toBe('?session=s%2Fa');
  useGlobalSessionsStore.setState({ directoryOf: { s2: '/two' } });
  window.history.replaceState({}, '', '/?session=s2');
  const push = vi.spyOn(window.history, 'pushState'); window.dispatchEvent(new PopStateEvent('popstate'));
  expect(useSessionViewStore.getState().currentSessionId).toBe('s2'); expect(push).not.toHaveBeenCalled(); push.mockRestore();
  window.history.replaceState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate'));
  expect(useSessionViewStore.getState().currentSessionId).toBe('s2');
});
it('drops the previous instance session route while preserving other URL state', async () => {
  window.history.replaceState({ marker: true }, '', '/?session=s1&other=preserved#anchor');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  stop = mountSessionRoute(failure);
  window.dispatchEvent(new CustomEvent('notnative:runtime-endpoint-will-change', { detail: { runtimeKey: 'remote' } }));
  runtime.key = 'remote';
  finish({ data: { id: 's1', directory: '/other' } } as never); await settle();
  expect(window.location.search).toBe('?other=preserved'); expect(window.location.hash).toBe('#anchor');
  expect(window.history.state).toEqual({ marker: true });
  expect(useSessionViewStore.getState().currentSessionId).toBeNull(); expect(failure).not.toHaveBeenCalled();
});
it('keeps the session route on same-instance transport switches and ordinary cleanup', () => {
  window.history.replaceState({}, '', '/?session=s1');
  useGlobalSessionsStore.setState({ directoryOf: { s1: '/one' } });
  stop = mountSessionRoute(failure);
  window.dispatchEvent(new CustomEvent('notnative:runtime-endpoint-will-change', { detail: { runtimeKey: 'local' } }));
  expect(window.location.search).toBe('?session=s1'); stop();
  window.dispatchEvent(new CustomEvent('notnative:runtime-endpoint-will-change', { detail: { runtimeKey: 'remote' } }));
  expect(window.location.search).toBe('?session=s1');
});
it.each(['settings=appearance', 'miniChat=1', 'ocPanel=session-chat', 'nn_url_token=secret'])('preserves %s', (query) => {
  window.history.replaceState({}, '', `/?${query}&session=s1`); stop = mountSessionRoute(failure);
  useSessionViewStore.setState({ currentSessionId: 's2' });
  expect(window.location.search).toBe(`?${query}&session=s1`); expect(harnessClient.getSession).not.toHaveBeenCalled();
});
it.each(['desktop', 'mobile'])('routes sessions on forced %s surfaces while preserving host identity', async (surface) => {
  window.history.replaceState({}, '', `/?surface=${surface}&session=s1#anchor`);
  vi.mocked(harnessClient.getSession).mockResolvedValue({ data: { id: 's1', directory: '/other' } as never });
  stop = mountSessionRoute(failure); await settle();
  expect(harnessClient.getSession).toHaveBeenCalledExactlyOnceWith('s1', { directory: '' });
  expect(useSessionViewStore.getState().currentSessionId).toBe('s1');
  useSessionViewStore.setState({ currentSessionId: 's2' });
  expect(window.location.search).toBe(`?surface=${surface}&session=s2`);
  expect(window.location.hash).toBe('#anchor');
});
it('rejects empty, oversized and control-bearing IDs', () => {
  for (const value of ['', ' s1', 's1\n', 'x'.repeat(257), null]) expect(routeSessionId(value)).toBeNull();
  expect(routeSessionId('s/a?x=1')).toBe('s/a?x=1');
});
it.each([['session=linked', false], ['miniChat=1&session=linked', true], ['session=%20bad', true]])(
  'guards persisted boot restoration for %s', async (query, shouldRestore) => {
    window.history.replaceState({}, '', `/?${query}`);
    const select = vi.fn();
    await openInitialSession({ currentSessionId: null, directory: '/initial', pointer: null, select,
      storeSessions: [{ id: 'welcome', title: 'Welcome to NotNativeDesktop', directory: '/initial', time: {} } as never] });
    expect(select).toHaveBeenCalledTimes(shouldRestore ? 1 : 0);
  },
);
it('does not restore a welcome session after an explicit draft during delayed boot', async () => {
  const navigationRevision = sessionNavigationRevision();
  window.history.replaceState({}, '', '/?session=linked');
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '/draft-project' });
  notifySessionRouteNavigation();
  // Cancelling the link clears its guard, but boot still must honor explicit draft intent.
  window.history.replaceState({}, '', '/');
  const select = vi.fn();
  await openInitialSession({ currentSessionId: null, directory: '/draft-project', navigationRevision, pointer: null, select,
    storeSessions: [{ id: 'welcome', title: 'Welcome to NotNativeDesktop', directory: '/draft-project', time: {} } as never] });
  expect(select).not.toHaveBeenCalled();
  expect(useSessionViewStore.getState().activeDirectory).toBe('/draft-project');
});
