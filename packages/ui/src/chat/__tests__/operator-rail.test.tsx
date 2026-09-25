// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail } from '../operator-rail.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

afterEach(() => {
  act(() => rootHandle?.unmount());
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
});

describe('OperatorRail', () => {
  it('renders only explicit activity evidence and keeps deferred surfaces honest', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'a1', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' },
      { id: 'a2', sessionID: 's2', time: 2, kind: 'turn', status: 'completed', summary: 'Other session' },
    ] });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="operator-rail"]')).not.toBeNull();
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-activity"]')!.textContent).toContain('Applied patch');
    expect(document.querySelector('[data-testid="operator-activity"]')!.textContent).not.toContain('Other session');
    act(() => (document.querySelector('button[aria-label="Browser"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-browser"]')!.textContent).toContain('reserved for the next integration slice');
  });

  it('filters activity to failures without claiming that all session evidence is absent', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'completed', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' },
      { id: 'failed', sessionID: 's1', time: 2, kind: 'tool', status: 'failed', summary: 'Command failed' },
    ] });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid="operator-activity"] button') as HTMLButtonElement).click());
    const activity = document.querySelector('[data-testid="operator-activity"]')!;
    expect(activity.textContent).toContain('Command failed');
    expect(activity.textContent).not.toContain('Applied patch');

    act(() => store.getState().patch({ activity: [{ id: 'completed', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' }] }));
    expect(activity.textContent).toContain('No failed activity evidence has been received for this session.');
    expect(activity.textContent).not.toContain('No activity evidence has been received for this session.');
  });

  it('loads the new directory preference without overwriting it during a live directory switch', () => {
    window.localStorage.setItem('nnd.operator-rail.surface:D:/alpha', 'activity');
    window.localStorage.setItem('nnd.operator-rail.surface:D:/beta', 'context');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/alpha" />));
    expect((document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');

    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/beta" />));
    expect((document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('nnd.operator-rail.surface:D:/beta')).toBe('context');
    expect(window.localStorage.getItem('nnd.operator-rail.surface:D:/alpha')).toBe('activity');
  });

  it('uses one preference for equivalent Windows directory spellings', () => {
    window.localStorage.setItem('nnd.operator-rail.surface:D:/same-project', 'activity');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory={'d:\\same-project'} />));
    expect((document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  });
});
