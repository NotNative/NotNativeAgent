// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { SessionTabs } from '../session-tabs.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(<></>));
  useGlobalSessionsStore.getState().reset();
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
});

function session(id: string, directory: string): Session {
  return { id, directory, title: id, time: { created: 1, updated: 1 } } as Session;
}

it('activating and closing tabs carries the selected session directory', () => {
  useGlobalSessionsStore.setState({ active: [session('Alpha', 'D:/alpha'), session('Beta', 'D:/beta')] });
  useSessionViewStore.setState({ currentSessionId: 'Alpha', activeDirectory: 'D:/alpha' });
  act(() => root.render(<SessionTabs engine={{} as never} directory="D:/alpha" />));
  act(() => useSessionViewStore.setState({ currentSessionId: 'Beta', activeDirectory: 'D:/beta' }));
  act(() => useSessionViewStore.setState({ currentSessionId: 'Alpha', activeDirectory: 'D:/alpha' }));
  const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
  expect(tabs).toHaveLength(2);
  act(() => tabs[1]!.querySelector<HTMLButtonElement>('button')!.click());
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: 'Beta', activeDirectory: 'D:/beta' });
  act(() => tabs[1]!.querySelector<HTMLButtonElement>('[aria-label="Close Beta tab"]')!.click());
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: 'Alpha', activeDirectory: 'D:/alpha' });
});

it('keeps the newest session visible after the nine-tab limit', () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`Session ${index + 1}`, 'D:/work'));
  useGlobalSessionsStore.setState({ active: sessions });
  useSessionViewStore.setState({ currentSessionId: sessions[0]!.id, activeDirectory: 'D:/work' });
  act(() => root.render(<SessionTabs engine={{} as never} directory="D:/work" />));
  for (const item of sessions.slice(1)) {
    act(() => useSessionViewStore.setState({ currentSessionId: item.id }));
  }
  const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
  expect(tabs).toHaveLength(9);
  expect(tabs[8]!.textContent).toContain('Session 10');
  expect([...tabs].some((tab) => tab.querySelector('button')?.textContent?.trim().endsWith('Session 1'))).toBe(false);
});

it('shows the selected session when its list entry arrives after the view pointer', () => {
  useSessionViewStore.setState({ currentSessionId: 'Late', activeDirectory: 'D:/late' });
  act(() => root.render(<SessionTabs engine={{} as never} directory="D:/late" />));
  expect(container.querySelector('[role="tab"]')).toBeNull();
  act(() => useGlobalSessionsStore.setState({ active: [session('Late', 'D:/late')] }));
  expect(container.querySelector('[role="tab"]')?.textContent).toContain('Late');
});
