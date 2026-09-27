// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

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
  expect(chatColumn.className).toContain('hidden lg:flex');
  expect(document.querySelector('[data-testid="operator-rail"]')?.getAttribute('data-open')).toBe('true');
  expect(document.activeElement?.getAttribute('data-testid')).toBe('operator-return-chat');
  await act(async () => (document.querySelector('[data-testid="operator-return-chat"]') as HTMLButtonElement).click());
  expect(chatColumn.className).toContain('flex');
  expect(chatColumn.className).not.toContain('hidden lg:flex');
  expect(document.activeElement).toBe(open);
});

it('reveals a focused rail when the viewport shrinks and restores the chat column when it grows', async () => {
  let wide = true;
  let change: ((event: MediaQueryListEvent) => void) | undefined;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
    get matches() { return wide; },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { change = listener; },
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
  expect(document.querySelector('[data-chat-column]')?.parentElement?.className).not.toContain('hidden lg:flex');
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
