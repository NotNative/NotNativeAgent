// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceRoute } from '../use-workspace-route.ts';
import { mountSessionRoute } from '../../lib/session-route.ts';
import { useContextRoute } from '../use-context-route.ts';
import { useContextRouteStore, requestContextRoute } from '../../lib/workspace-route.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
vi.mock('../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => 'local' }));
vi.mock('../../lib/nnd/client.ts', () => ({ harnessClient: { getSession: vi.fn() }, normalizeDirectory: (value: string) => value }));
vi.mock('../../sync/persist-cache.ts', () => ({ persistLastActiveSession: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const showChat = vi.fn(); const failure = vi.fn();
function Harness() {
  useEffect(() => mountSessionRoute(failure), []);
  const route = useWorkspaceRoute('local', showChat);
  return <><span data-page>{route.settingsPage ?? 'closed'}</span>
    <button onClick={() => route.openSettings('appearance')}>Appearance</button>
    <button onClick={() => route.openSettings('notifications')}>Notifications</button>
    <button onClick={route.closeSettings}>Close</button></>;
}
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/');
  useContextRouteStore.setState({ request: null });
  useSessionViewStore.setState({ currentSessionId: 'current', activeDirectory: '/one' });
  useGlobalSessionsStore.setState({ directoryOf: { current: '/one' } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async () => { await act(async () => root.render(<Harness />)); };
const click = async (index: number) => { await act(async () => container.querySelectorAll('button')[index]!.click()); };
const pop = async (url: string) => { await act(async () => { window.history.replaceState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }); };
it('opens, switches and closes settings with canonical browser history', async () => {
  await render(); await click(0); expect(window.location.search).toBe('?settings=appearance');
  await click(1); expect(window.location.search).toBe('?settings=notifications');
  await click(2); expect(window.location.search).toBe('?session=current');
  const push = vi.spyOn(window.history, 'pushState');
  await pop('/?settings=APPEARANCE'); expect(container.querySelector('[data-page]')?.textContent).toBe('appearance');
  await pop('/'); expect(container.querySelector('[data-page]')?.textContent).toBe('closed');
  expect(useSessionViewStore.getState().currentSessionId).toBe('current'); expect(push).not.toHaveBeenCalled(); push.mockRestore();
});
it('normalizes settings aliases and ignores simultaneous session/tab/file params', async () => {
  window.history.replaceState({}, '', '/?settings=preferences&session=other&tab=diff&file=x');
  await render(); expect(window.location.search).toBe('?settings=general');
  expect(container.querySelector('[data-page]')?.textContent).toBe('general');
  expect(harnessClient.getSession).not.toHaveBeenCalled(); expect(showChat).not.toHaveBeenCalled();
});
it.each(['desktop', 'mobile'])('applies settings links and preserves the forced %s surface', async (surface) => {
  window.history.replaceState({}, '', `/?surface=${surface}&settings=APPEARANCE#anchor`);
  await render();
  expect(container.querySelector('[data-page]')?.textContent).toBe('appearance');
  expect(window.location.search).toBe(`?surface=${surface}&settings=appearance`);
  await click(2);
  expect(window.location.search).toBe(`?surface=${surface}&session=current`);
  expect(window.location.hash).toBe('#anchor');
});
it('waits for the linked session before opening its file in the context rail', async () => {
  window.history.replaceState({}, '', '/?session=other&file=src%2Fa.ts');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); expect(useContextRouteStore.getState().request).toBeNull();
  await act(async () => finish({ data: { id: 'other', directory: '/two' } } as never));
  expect(useContextRouteStore.getState().request).toMatchObject({ directory: '/two', session: 'other', tab: 'diff', file: 'src/a.ts' });
  expect(window.location.search).toBe('?session=other'); expect(showChat).toHaveBeenCalled();
});
it('opening settings cancels pending linked-session replies', async () => {
  window.history.replaceState({}, '', '/?session=other&tab=git');
  let finish!: (result: never) => void;
  vi.mocked(harnessClient.getSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await click(0);
  await act(async () => finish({ data: { id: 'other', directory: '/two' } } as never));
  expect(useSessionViewStore.getState().currentSessionId).toBe('current');
  expect(useContextRouteStore.getState().request).toBeNull();
});
it.each(['git', 'diff', 'terminal', 'files', 'chat'])('routes legacy %s into the current chat context', async (tab) => {
  window.history.replaceState({}, '', `/?tab=${tab}&file=x`); await render();
  expect(useContextRouteStore.getState().request).toMatchObject({ tab, directory: '/one', file: tab === 'diff' ? 'x' : null });
  expect(window.location.search).toBe('?session=current');
});
it('does not replay legacy tab intent after explicit session navigation', async () => {
  window.history.replaceState({}, '', '/?tab=terminal'); await render();
  await act(async () => useSessionViewStore.setState({ currentSessionId: 'next' }));
  expect(useContextRouteStore.getState().request).toBeNull(); expect(window.location.search).toBe('?session=next');
});
it('does not replay a consumed legacy tab after opening and closing settings', async () => {
  window.history.replaceState({}, '', '/?tab=terminal'); await render();
  const calls = showChat.mock.calls.length;
  await click(0); await click(2);
  expect(useContextRouteStore.getState().request).toBeNull();
  expect(showChat).toHaveBeenCalledTimes(calls);
});
it('retains legacy tab intent while cold bootstrap adopts the last active session', async () => {
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
  window.history.replaceState({}, '', '/?tab=terminal'); await render();
  await act(async () => useSessionViewStore.setState({ currentSessionId: 'current', activeDirectory: '/one' }));
  expect(useContextRouteStore.getState().request).toMatchObject({ tab: 'terminal', directory: '/one', session: 'current' });
});
it('waits for the displayed chat identity before consuming a context request', async () => {
  const apply = vi.fn();
  function Probe({ session }: { session: string }) { useContextRoute('/one', session, apply); return null; }
  await act(async () => { root.render(<Probe session="old" />); requestContextRoute({ runtime: 'local', directory: '/one', session: 'new', tab: 'files', file: null }); });
  expect(apply).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe session="new" />)); expect(apply).toHaveBeenCalledOnce();
});
