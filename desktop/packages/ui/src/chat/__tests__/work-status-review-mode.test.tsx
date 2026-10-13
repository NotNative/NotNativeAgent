// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';
import type { Session } from '../../lib/nnd/types.ts';
vi.mock('../review-mode-control.tsx', () => ({ ReviewModeControl: ({ sessionID, busy }: { sessionID: string; busy: boolean }) =>
  <div data-testid="review-mode-probe" data-session={sessionID} data-busy={String(busy)} /> }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const session = (parentID?: string): Session => ({ id: 's1', slug: 's1', projectID: 'project', directory: '/work',
  title: 'Session', parentID, version: '1', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 } });
afterEach(() => {
  act(() => root?.unmount()); container?.remove(); root = null; container = null;
  useGlobalSessionStatusStore.setState({ statusById: {} });
});

it.each([{ engine: 'nna', parentID: undefined, visible: true },
  { engine: 'nna', parentID: 'parent', visible: false },
  { engine: 'mock', parentID: undefined, visible: false }])(
  'offers NNA permission controls only on NNA root sessions: %j', ({ engine, parentID, visible }) => {
    const store = createDirectoryStore();
    store.setState({ config: { nnd: { engine } } as never,
      session: [session(parentID)] });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} sessionID="s1" embedded />));
    const probe = container.querySelector('[data-testid="review-mode-probe"]');
    expect(probe !== null).toBe(visible);
    if (visible) expect(probe?.getAttribute('data-session')).toBe('s1');
  });

it('reflects live busy status in the permission control', () => {
  const store = createDirectoryStore();
  store.setState({ config: { nnd: { engine: 'nna' } } as never,
    session: [session()] });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} sessionID="s1" embedded />));
  expect(container.querySelector('[data-testid="review-mode-probe"]')?.getAttribute('data-busy')).toBe('false');
  act(() => useGlobalSessionStatusStore.setState({ statusById: { s1: { type: 'busy' } } }));
  expect(container.querySelector('[data-testid="review-mode-probe"]')?.getAttribute('data-busy')).toBe('true');
});
