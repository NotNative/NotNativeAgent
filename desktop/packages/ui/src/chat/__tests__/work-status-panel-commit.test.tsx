// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import type { DirectoryStore } from '../../sync/types.ts';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
});

it('commits completed-turn stats once and never leaks them to another session', async () => {
  const store = createDirectoryStore();
  store.setState({
    sessionStatusReady: true,
    message: {
      s1: [
        { id: 'user-1', sessionID: 's1', role: 'user', time: { created: 100 } },
        { id: 'assistant-1', sessionID: 's1', role: 'assistant', time: { created: 200, completed: 1100 },
          providerID: 'p', modelID: 'm', tokens: { total: 20, input: 10, output: 10 } },
      ],
      s2: [],
    },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  let commits = 0;
  await act(async () => {
    root!.render(<Profiler id="context" onRender={() => { commits += 1; }}>
      <WorkStatusPanel store={store} engine={{} as never} embedded />
    </Profiler>);
    await Promise.resolve();
  });
  expect(container.textContent).toContain('Whole turn');
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(commits).toBeLessThanOrEqual(3);
  await act(async () => useSessionViewStore.setState({ currentSessionId: 's2' }));
  expect(container.textContent).not.toContain('Whole turn');
});

it('shows only reported usage in expanded Context and labels paged message counts as loaded', () => {
  const store = createDirectoryStore();
  store.setState({
    session: [{ id: 's1', title: 'Investigate build', time: { created: 1, updated: 1 }, metadata: {
      nnd: { context: { estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated' } },
    } }],
    message: { s1: [
      { id: 'user-1', sessionID: 's1', role: 'user', time: { created: 100 } },
      { id: 'assistant-1', sessionID: 's1', role: 'assistant', time: { created: 200, completed: 1100 },
        providerID: 'p', modelID: 'm', tokens: { input: 200, output: 25, cache: { read: 800 } } },
    ] },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded />));
  const usage = document.querySelector('[data-testid="context-usage-summary"]')!;
  expect(document.querySelector('[data-testid="context-session-header"]')?.textContent).toContain('Investigate build');
  expect(usage.textContent).toContain('4,000 estimated tokens / 16,000 limit');
  expect(usage.textContent).toContain('Loaded messages2');
  expect(usage.textContent).toContain('Loaded user1');
  expect(usage.textContent).toContain('Loaded assistant1');
  expect(usage.textContent).toContain('Cache read800');
  expect(usage.textContent).not.toContain('Cache write');
  expect(usage.textContent).not.toContain('Recorded cost');
  expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
});

it('shows session identity and an honest context meter in the docked rail', () => {
  const store = createDirectoryStore();
  store.setState({ session: [
    { id: 's1', title: 'Investigate build', time: { created: 1, updated: 1 }, metadata: { nnd: {
      configuredModel: { providerID: 'local', modelID: 'coder' },
      context: { estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated' },
    } } },
    { id: 's2', title: 'Review changes', time: { created: 2, updated: 2 }, metadata: { nnd: {
      context: { estimatedTokens: 5_000, measurement: 'estimated' },
    } } },
  ] } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded />));
  expect(container.querySelector('[data-testid="context-session-header"]')?.textContent).toContain('Investigate build');
  expect(container.querySelector('[data-testid="context-session-header"]')?.textContent).toContain('local · coder');
  const usage = container.querySelector('[data-testid="context-usage-summary"]')!;
  expect(usage.textContent).toContain('4,000 estimated tokens / 16,000 limit');
  expect(usage.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
  expect(container.querySelector('[data-testid="context-message-ledger"]')).toBeNull();
  act(() => useSessionViewStore.setState({ currentSessionId: 's2' }));
  expect(container.querySelector('[data-testid="context-session-header"]')?.textContent).toContain('Review changes');
  expect(container.querySelector('[data-testid="context-session-header"]')?.textContent).not.toContain('local · coder');
  expect(container.querySelector('[data-testid="context-usage-summary"]')?.textContent).toContain('5,000 estimated tokens · limit unknown');
  expect(container.querySelector('[data-testid="context-usage-summary"] [role="progressbar"]')).toBeNull();
});

it('uses the reporting assistant model for the docked context percentage', () => {
  const store = createDirectoryStore();
  store.setState({
    session: [{ id: 's1', title: 'Review', time: { created: 1, updated: 1 } }],
    provider: [
      { id: 'other', models: { first: { limit: { context: 200 } } } },
      { id: 'p', models: {
        first: { limit: { context: 100 } },
        next: { limit: { context: 200 } },
      } },
    ],
    message: { s1: [
      { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 1 }, providerID: 'p', modelID: 'first', tokens: { total: 25 } },
      { id: 'a2', sessionID: 's1', role: 'assistant', time: { created: 2 }, providerID: 'p', modelID: 'next' },
    ] },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded />));
  const usage = container.querySelector('[data-testid="context-usage-summary"]')!;
  expect(usage.textContent).toContain('25 reported tokens · 25.0% of model limit');
  expect(usage.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
});

it('does not borrow a provider percentage for an NNA estimate with unknown limit', () => {
  const store = createDirectoryStore();
  const session = { id: 's1', title: 'Review', time: { created: 1, updated: 1 } };
  store.setState({
    session: [{ ...session, metadata: { nnd: { context: { estimatedTokens: 4_000, measurement: 'estimated' } } } }],
    provider: [{ id: 'p', models: { m: { limit: { context: 100 } } } }],
    message: { s1: [{ id: 'assistant-1', sessionID: 's1', role: 'assistant', time: { created: 2 },
      providerID: 'p', modelID: 'm', tokens: { total: 25, input: 20, output: 5 } }] },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded />));
  const usage = document.querySelector('[data-testid="context-usage-summary"]')!;
  expect(usage.textContent).toContain('4,000 estimated tokens · limit unknown');
  expect(usage.querySelector('[role="progressbar"]')).toBeNull();
  act(() => store.setState({ session: [session] } as unknown as Partial<DirectoryStore>));
  expect(usage.textContent).toContain('25 reported tokens · 25.0% of model limit');
  expect(usage.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
});

it('renders a loaded-message ledger without leaking user, tool, or reasoning payloads', () => {
  const store = createDirectoryStore();
  store.setState({
    session: [{ id: 's1', title: 'Review', time: { created: 1, updated: 1 } }],
    message: { s1: [
      { id: 'u1', sessionID: 's1', role: 'user', time: { created: 1 } },
      { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 2 }, tokens: { input: 240, output: 12 } },
    ] },
    part: {
      u1: [{ id: 'p1', sessionID: 's1', messageID: 'u1', type: 'text', text: 'private request' }],
      a1: [{ id: 'p2', sessionID: 's1', messageID: 'a1', type: 'reasoning', text: 'private reasoning', time: { start: 2 } },
        { id: 'p3', sessionID: 's1', messageID: 'a1', type: 'tool', tool: 'bash', state: { status: 'completed', output: 'secret output' } }],
    },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded />));
  const ledger = document.querySelector('[data-testid="context-message-ledger"]')!;
  expect(ledger.textContent).toContain('assistant · reasoning + tool');
  expect(ledger.textContent).toContain('240 / 12');
  expect(ledger.textContent).toContain('2 loaded');
  expect(ledger.textContent).not.toMatch(/private request|private reasoning|secret output/);
  expect(container.textContent).not.toContain('NNA context details are not available');
  expect(container.textContent).not.toContain('All sections hidden');
});

it('keeps the long message ledger out of the docked Context rail', () => {
  const store = createDirectoryStore();
  store.setState({
    session: [{ id: 's1', title: 'Review', time: { created: 1, updated: 1 } }],
    message: { s1: Array.from({ length: 120 }, (_, index) => ({
      id: `a${index}`, sessionID: 's1', role: 'assistant', time: { created: index + 1 },
    })) },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded />));
  expect(container.querySelector('[data-testid="context-message-ledger"]')).toBeNull();
  expect(container.textContent).toContain('NNA context details are not available');
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded />));
  expect(container.querySelectorAll('[data-testid="context-message-ledger"] li')).toHaveLength(100);
  expect(container.textContent).toContain('Newest 100 of 120 loaded');
  expect(container.textContent).not.toContain('NNA context details are not available');
  expect(container.textContent).not.toContain('All sections hidden');
});
