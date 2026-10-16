// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';

vi.mock('../transcript.tsx', () => ({ Transcript: () => <div data-testid="transcript-stub" />, StatusChip: () => null }));
vi.mock('../prompt-rail.tsx', () => ({ PromptNavigatorRail: () => null }));
vi.mock('../composer.tsx', () => ({ Composer: ({ onToggleExpanded }: { onToggleExpanded: () => void }) => <><input data-testid="composer-stub" /><button data-testid="toggle-expanded" onClick={onToggleExpanded}>Expand</button></> }));
vi.mock('../operator-rail.tsx', () => ({ OperatorRail: ({ compactOpen, suppressed, onCloseCompact }: {
  compactOpen: boolean; suppressed: boolean; onCloseCompact: () => void;
}) => <aside data-testid="operator-rail" data-open={compactOpen} data-suppressed={suppressed}><button data-testid="operator-return-chat" onClick={onCloseCompact}>Return to chat</button><button data-testid="rail-surface">Context</button></aside> }));

import { ChatView } from '../chat-view.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalMatchMedia = window.matchMedia;
const session = (id: string, title: string, parentID?: string): Session => ({
  id, slug: id, projectID: 'proj', directory: '/proj', parentID, title, version: '1',
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  useSessionViewStore.setState({ activeDirectory: '/proj', currentSessionId: null });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  vi.restoreAllMocks();
});

it('puts child steering in the transcript header and returns to its known parent', async () => {
  vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue({ data: {
    session_id: 'child', revision: 1, capabilities: { steer_subagent: true }, availability: 'granted',
  } });
  const store = createDirectoryStore();
  store.getState().patch({ session: [session('parent', 'Main task'), { ...session('child', 'Research', 'parent'), agent: 'explore' }] });
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  useSessionViewStore.setState({ activeDirectory: '/proj', currentSessionId: 'child' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />); await Promise.resolve(); });
  const header = document.querySelector('[data-testid="child-transcript-header"]') as HTMLElement;
  expect(header.textContent).toContain('Research');
  expect(header.textContent).toContain('explore');
  expect(header.querySelector('button[aria-expanded="false"]')?.textContent).toBe('Steer subagent');
  expect(header.querySelector('textarea')).toBeNull();
  expect(header.compareDocumentPosition(document.querySelector('[data-chat-column]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.querySelector('[data-composer-bound]')).toBeNull();
  await act(async () => (header.querySelector('[data-testid="return-to-parent"]') as HTMLButtonElement).click());
  expect(useSessionViewStore.getState().currentSessionId).toBe('parent');
});

it('does not offer a return action when the child parent is unavailable', async () => {
  vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue({ data: {
    session_id: 'child', revision: 1, capabilities: { steer_subagent: false }, availability: 'unavailable',
  } });
  const store = createDirectoryStore();
  store.getState().patch({ session: [session('child', 'Research', 'missing')] });
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  useSessionViewStore.setState({ activeDirectory: '/proj', currentSessionId: 'child' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />); await Promise.resolve(); });
  expect(document.querySelector('[data-testid="parent-unavailable"]')?.textContent).toContain('unavailable');
  expect(document.querySelector('[data-testid="return-to-parent"]')).toBeNull();
});

it('keeps a child transcript visible after switching away from an expanded parent composer', async () => {
  vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue({ data: {
    session_id: 'child', revision: 1, capabilities: { steer_subagent: false }, availability: 'unavailable',
  } });
  const store = createDirectoryStore();
  store.getState().patch({ session: [session('parent', 'Main task'), session('child', 'Research', 'parent')], message: { parent: [], child: [] } });
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  useSessionViewStore.setState({ activeDirectory: '/proj', currentSessionId: 'parent' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />));
  await act(async () => (document.querySelector('[data-testid="toggle-expanded"]') as HTMLButtonElement).click());
  expect(document.querySelector('[data-chat-column]')?.className).toContain('hidden');
  await act(async () => useSessionViewStore.setState({ currentSessionId: 'child' }));
  expect(document.querySelector('[data-testid="child-transcript-header"]')).toBeTruthy();
  expect(document.querySelector('[data-chat-column]')?.className).not.toContain('hidden');
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-suppressed')).toBe('false');
  expect(document.querySelector('[data-composer-bound]')).toBeNull();
});

it('foregrounds compact operator surfaces and returns focus to chat without removing the wide chat layout', async () => {
  const store = createDirectoryStore();
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  const open = document.querySelector('[data-testid="open-operator-surfaces"]') as HTMLButtonElement;
  expect(open).toBeTruthy();
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-open')).toBe('false');
  await act(async () => open.click());
  const chatColumn = document.querySelector('[data-chat-column]')!.parentElement!;
  expect(chatColumn.className).toContain('hidden min-[1100px]:flex');
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-open')).toBe('true');
  expect(document.activeElement?.getAttribute('data-testid')).toBe('operator-return-chat');
  await act(async () => (document.querySelector('[data-testid="operator-return-chat"]') as HTMLButtonElement).click());
  expect(chatColumn.className).toContain('flex');
  expect(chatColumn.className).not.toContain('hidden min-[1100px]:flex');
  expect(document.activeElement).toBe(open);
});

it('reveals a focused rail when the viewport shrinks and restores the chat column when it grows', async () => {
  let wide = true;
  let change: ((event: MediaQueryListEvent) => void) | undefined;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
    get matches() { return wide; },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { if (query === '(min-width: 1100px)') change = listener; },
    removeEventListener: () => undefined,
  }) });
  const store = createDirectoryStore();
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />));
  const railSurface = document.querySelector('[data-testid="rail-surface"]') as HTMLButtonElement;
  railSurface.focus();
  wide = false;
  await act(async () => change?.({ matches: false } as MediaQueryListEvent));
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-open')).toBe('true');
  expect(document.activeElement).toBe(railSurface);
  wide = true;
  await act(async () => change?.({ matches: true } as MediaQueryListEvent));
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-open')).toBe('false');
  expect(document.querySelector('[data-chat-column]')?.parentElement?.className).not.toContain('hidden min-[1100px]:flex');
  expect(document.activeElement).toBe(railSurface);
});

it('keeps the rail mounted but suppressed when the composer enters expanded mode', async () => {
  const store = createDirectoryStore();
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />));
  const rail = document.querySelector('[data-testid="operator-rail"]');
  await act(async () => (document.querySelector('[data-testid="toggle-expanded"]') as HTMLButtonElement).click());
  expect(document.querySelector('[data-testid="operator-rail"]')).toBe(rail);
  expect(rail?.getAttribute('data-suppressed')).toBe('true');
});

it('centers the draft starting point and restores the transcript layout for a selected session', async () => {
  const store = createDirectoryStore();
  const engine = { childStoreOf: () => store, manager: { ensureChild: () => store } } as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatView services={{ engine, store: () => store, dispatch: () => undefined }} currentDirectory="/proj" />));
  expect(document.querySelector('[data-testid="chat-draft-landing"]')?.textContent).toContain('proj');
  expect(document.querySelector('[data-composer-bound]')?.className).toContain('overflow-y-auto');
  expect(document.querySelector('[data-composer-bound] > div')?.className).toContain('my-auto');
  expect(document.querySelector('[data-testid="transcript-stub"]')).toBeNull();
  act(() => store.setState({ session: [{ id: 's1', title: 'Existing session' }], message: { s1: [] } } as never));
  await act(async () => useSessionViewStore.setState({ currentSessionId: 's1' }));
  expect(document.querySelector('[data-testid="chat-draft-landing"]')).toBeNull();
  expect(document.querySelector('[data-testid="transcript-stub"]')).toBeTruthy();
  expect(document.querySelector('[data-composer-bound]')?.className).toContain('border-t');
});
