// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { Transcript } from '../transcript.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';

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
