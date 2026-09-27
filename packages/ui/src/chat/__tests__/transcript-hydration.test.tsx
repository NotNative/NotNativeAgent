// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { Transcript } from '../transcript.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(engine: SyncEngine, store = createDirectoryStore()): Promise<typeof store> {
  container = document.createElement('div');
  container.setAttribute('data-chat-column', '');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Transcript store={store} engine={engine} sessionID="s1" directory="D:/work" />));
  return store;
}

it('hydrates an opened session instead of leaving the skeleton indefinitely', async () => {
  const store = createDirectoryStore();
  const ensure = vi.fn(async (_target: unknown, _opts: unknown) => {
    store.setState({ message: { ...store.getState().message, s1: [] } });
  });
  const engine = { loader: { ensure, getState: () => ({ status: 'ready' }) } } as unknown as SyncEngine;
  await mount(engine, store);
  expect(ensure).toHaveBeenCalledWith({ directory: 'D:/work', sessionID: 's1', store }, { reason: 'navigation', force: false });
  expect(container?.textContent).toContain('Session is open, nothing has been sent yet.');
});

it('shows a retry action after a failed load and retries the same session', async () => {
  const store = createDirectoryStore();
  let attempts = 0;
  const ensure = vi.fn(async (_target: unknown, _opts: unknown) => {
    attempts += 1;
    if (attempts === 2) store.setState({ message: { ...store.getState().message, s1: [] } });
  });
  const engine = { loader: { ensure, getState: () => ({ status: attempts === 1 ? 'error' : 'ready' }) } } as unknown as SyncEngine;
  await mount(engine, store);
  expect(container?.querySelector('[data-testid="chat-load-error"]')).not.toBeNull();
  await act(async () => (container?.querySelector('button') as HTMLButtonElement).click());
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(ensure.mock.calls[1]?.[1]).toEqual({ reason: 'navigation', force: true });
  expect(container?.textContent).toContain('Session is open, nothing has been sent yet.');
});

it('does not mistake an existing empty bucket for a successful load after failure', async () => {
  const store = createDirectoryStore({ message: { s1: [] } });
  const ensure = vi.fn(async () => undefined);
  const engine = { loader: { ensure, getState: () => ({ status: 'error' }) } } as unknown as SyncEngine;
  await mount(engine, store);
  expect(container?.querySelector('[data-testid="chat-load-error"]')).not.toBeNull();
  expect(container?.textContent).not.toContain('nothing has been sent yet');
});

it('loads an older transcript page on demand and retires the control at the end', async () => {
  const store = createDirectoryStore();
  const message = (id: string, created: number): Message => ({ id, sessionID: 's1', role: 'user', time: { created } }) as Message;
  const part = (id: string): Part => ({ id: `p-${id}`, sessionID: 's1', messageID: id, type: 'text', text: id }) as Part;
  let page = 0;
  const ensure = vi.fn(async () => {
    store.setState({ message: { s1: [message('newer', 2)] }, part: { newer: [part('newer')] } });
  });
  const loadOlder = vi.fn(async () => {
    page = 1;
    store.setState({ message: { s1: [message('older', 1), message('newer', 2)] }, part: { older: [part('older')], newer: [part('newer')] } });
  });
  const engine = { loader: {
    ensure, loadOlder, getState: () => ({ status: 'ready', cursor: page === 0 ? 'before-newer' : undefined, complete: page > 0 }),
  } } as unknown as SyncEngine;
  await mount(engine, store);
  const button = container?.querySelector('[data-testid="load-older-messages"]') as HTMLButtonElement;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(loadOlder).toHaveBeenCalledWith({ directory: 'D:/work', sessionID: 's1', store });
  expect(store.getState().message.s1?.map((entry) => entry.id)).toEqual(['older', 'newer']);
  expect(container?.querySelector('[data-testid="load-older-messages"]')).toBeNull();
});

it('holds the first visible message in place when an older page is prepended', async () => {
  const store = createDirectoryStore();
  const message = (id: string, created: number): Message => ({ id, sessionID: 's1', role: 'user', time: { created } }) as Message;
  const part = (id: string): Part => ({ id: `p-${id}`, sessionID: 's1', messageID: id, type: 'text', text: id }) as Part;
  let page = 0;
  let anchorTop = 100;
  const engine = { loader: {
    ensure: async () => store.setState({ message: { s1: [message('newer', 2)] }, part: { newer: [part('newer')] } }),
    loadOlder: async () => {
      page = 1;
      anchorTop = 340;
      store.setState({ message: { s1: [message('older', 1), message('newer', 2)] }, part: { older: [part('older')], newer: [part('newer')] } });
    },
    getState: () => ({ status: 'ready', cursor: page === 0 ? 'before-newer' : undefined, complete: page > 0 }),
  } } as unknown as SyncEngine;
  await mount(engine, store);
  const viewport = container!;
  viewport.scrollTop = 200;
  const current = container!.querySelector('#message-newer') as HTMLElement;
  vi.spyOn(current, 'getBoundingClientRect').mockImplementation(() => ({ top: anchorTop }) as DOMRect);
  await act(async () => (container?.querySelector('[data-testid="load-older-messages"]') as HTMLButtonElement).click());
  expect(viewport.scrollTop).toBe(440);
});

it('does not disable another session’s older-page control while a request is pending', async () => {
  const store = createDirectoryStore();
  const message = (sessionID: string): Message => ({ id: `m-${sessionID}`, sessionID, role: 'user', time: { created: 1 } }) as Message;
  const part = (sessionID: string): Part => ({ id: `p-${sessionID}`, sessionID, messageID: `m-${sessionID}`, type: 'text', text: sessionID }) as Part;
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const engine = { loader: {
    ensure: async ({ sessionID }: { sessionID: string }) => {
      store.setState({ message: { ...store.getState().message, [sessionID]: [message(sessionID)] }, part: { ...store.getState().part, [`m-${sessionID}`]: [part(sessionID)] } });
    },
    loadOlder: async ({ sessionID }: { sessionID: string }) => { if (sessionID === 's1') await firstPending; },
    getState: () => ({ status: 'ready', cursor: 'older', complete: false }),
  } } as unknown as SyncEngine;
  await mount(engine, store);
  await act(async () => (container?.querySelector('[data-testid="load-older-messages"]') as HTMLButtonElement).click());
  // The request above is unresolved; a navigation must still offer s2's history.
  await act(async () => root!.render(<Transcript store={store} engine={engine} sessionID="s2" directory="D:/work" />));
  const second = container?.querySelector('[data-testid="load-older-messages"]') as HTMLButtonElement;
  expect(second.disabled).toBe(false);
  expect(second.textContent).toContain('Load older messages');
  await act(async () => releaseFirst?.());
});

it('discards a pending scroll anchor when the same session switches stores', async () => {
  const message = (id: string): Message => ({ id, sessionID: 's1', role: 'user', time: { created: 1 } }) as Message;
  const part = (id: string): Part => ({ id: `p-${id}`, sessionID: 's1', messageID: id, type: 'text', text: id }) as Part;
  const firstStore = createDirectoryStore({ message: { s1: [message('shared')] }, part: { shared: [part('shared')] } });
  const secondStore = createDirectoryStore({ message: { s1: [message('shared')] }, part: { shared: [part('shared')] } });
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const engine = { loader: {
    ensure: async () => undefined,
    loadOlder: async () => {
      await firstPending;
      firstStore.setState({ message: { s1: [message('older'), message('shared')] }, part: { older: [part('older')], shared: [part('shared')] } });
    },
    getState: () => ({ status: 'ready', cursor: 'older', complete: false }),
  } } as unknown as SyncEngine;
  await mount(engine, firstStore);
  container!.scrollTop = 200;
  const current = container!.querySelector('#message-shared') as HTMLElement;
  vi.spyOn(current, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 }) as DOMRect);
  await act(async () => (container?.querySelector('[data-testid="load-older-messages"]') as HTMLButtonElement).click());
  await act(async () => root!.render(<Transcript store={secondStore} engine={engine} sessionID="s1" directory="D:/work" />));
  await act(async () => releaseFirst?.());
  expect(container!.scrollTop).toBe(200);
  expect(container?.querySelector('#message-older')).toBeNull();
});
