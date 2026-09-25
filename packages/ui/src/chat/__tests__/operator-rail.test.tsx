// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail } from '../operator-rail.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';

vi.mock('../../components/terminal/TerminalView.tsx', () => ({ TerminalView: ({ visible }: { visible: boolean }) => <div data-testid="terminal-keepalive-controller" data-visible={visible} /> }));

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
  useGlobalSessionStatusStore.getState().reset();
  vi.unstubAllGlobals();
});

describe('OperatorRail', () => {
  it('stops terminal foreground work when the desktop rail becomes compact-hidden', () => {
    let change: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { change = listener; },
      removeEventListener: () => undefined,
    }));
    window.localStorage.setItem('nnd.operator-rail.surface:D:/work', 'terminal');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const terminal = document.querySelector('[data-testid="terminal-keepalive-controller"]');
    expect(terminal?.getAttribute('data-visible')).toBe('true');
    act(() => change?.({ matches: false } as MediaQueryListEvent));
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('false');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen />));
    expect(terminal?.getAttribute('data-visible')).toBe('true');
  });
  it('keeps an opened terminal mounted but not visible while focus mode suppresses the rail', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    window.localStorage.setItem('nnd.operator-rail.surface:D:/work', 'terminal');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const terminal = document.querySelector('[data-testid="terminal-keepalive-controller"]');
    expect(terminal?.getAttribute('data-visible')).toBe('true');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" suppressed />));
    const rail = document.querySelector('[data-testid="operator-rail"]')!;
    expect(rail.className).toContain('hidden');
    expect(rail.className).not.toContain('xl:flex');
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('false');
  });
  it('exposes one full-width compact surface with a return-to-chat control', () => {
    const store = createDirectoryStore();
    const close = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen onCloseCompact={close} />));
    const rail = document.querySelector('[data-testid="operator-rail"]')!;
    expect(rail.className).toContain('w-full xl:w-[300px]');
    expect(rail.className).not.toContain('hidden xl:flex');
    act(() => (document.querySelector('[data-testid="operator-return-chat"]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
  });
  it('shows NNA estimated context without inventing provider-billed usage', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ session: [{ id: 's1', metadata: { nnd: { context: {
      estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated', observedAt: 1,
    } } }, time: { created: 1, updated: 1 } }] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('25.0% estimated');
    expect(context.textContent).toContain('4,000 tokens');
    expect(context.textContent).toContain('16,000 tokens');
    expect(context.textContent).not.toContain('$0.00');
  });

  it('follows a selected session change even without a directory-store update', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ session: [
      { id: 's1', metadata: { nnd: { context: { estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated' } } }, time: { created: 1, updated: 1 } },
      { id: 's2', metadata: { nnd: { context: { estimatedTokens: 8_000, limitTokens: 16_000, measurement: 'estimated' } } }, time: { created: 1, updated: 1 } },
    ] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="work-status-panel"]')!.textContent).toContain('25.0% estimated');

    act(() => useSessionViewStore.getState().setCurrentSession('s2'));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('50.0% estimated');
    expect(context.textContent).not.toContain('25.0% estimated');
  });

  it('does not call an unreported subagent done and refreshes blocker precedence live', () => {
    useSessionViewStore.setState({ currentSessionId: 'parent' });
    const store = createDirectoryStore({ session: [
      { id: 'parent', time: { created: 1, updated: 1 } },
      { id: 'child', parentID: 'parent', title: 'Explorer', time: { created: 2, updated: 2 } },
    ] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const subagents = document.querySelector('[data-testid="ws-subagents"]')!;
    expect(subagents.textContent).toContain('No live status');
    expect(subagents.textContent).not.toContain('Done');

    act(() => useGlobalSessionStatusStore.getState().applyEvent('child', { type: 'busy' }));
    expect(subagents.textContent).toContain('working');
    act(() => store.getState().patch({ permission: { child: [{ id: 'p1' }] } as never }));
    expect(subagents.textContent).toContain('needs permission');
    expect(subagents.textContent).not.toContain('working');
    act(() => store.getState().patch({ permission: {}, question: { child: [{ id: 'q1' }] } as never }));
    expect(subagents.textContent).toContain('asked a question');
    act(() => store.getState().patch({ question: {} }));
    act(() => useGlobalSessionStatusStore.getState().applyEvent('child', { type: 'idle' }));
    expect(subagents.textContent).toContain('No live status');
    act(() => store.getState().patch({ session_status: { child: { type: 'idle' } } }));
    expect(subagents.textContent).toContain('Idle');
    expect(subagents.textContent).not.toContain('Done');
    act(() => store.getState().patch({ session_status: {}, sessionStatusReady: true }));
    expect(subagents.textContent).toContain('No live status');
  });

  it('renders only explicit activity evidence and offers a bounded browser preview', () => {
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
    expect(document.querySelector('[data-testid="operator-browser"]')!.textContent).toContain('isolated web preview');
    expect(document.querySelector('[data-testid="operator-browser"] iframe')).toBeNull();
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
