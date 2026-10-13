// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { ChatSidebar } from '../session-sidebar.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionFoldersStore } from '../../stores/useSessionFoldersStore.ts';
import { useSessionPinnedStore } from '../../stores/useSessionPinnedStore.ts';
import { useSessionExpansionStore } from '../../stores/useSessionExpansionStore.ts';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '../../lib/runtime-switch.ts';

const suggestFetch = vi.hoisted(() => ({ impl: null as null | ((url: string) => Promise<Response>) }));
vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/sessions/') || !url.includes('/suggest-name')) {
      throw new Error(`unexpected fetch ${url}`);
    }
    if (init?.method !== 'POST') throw new Error(`unexpected method ${String(init?.method)}`);
    return suggestFetch.impl!(url);
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalSessionLoad: () => Promise<void>;
let originalFolderLoad: () => Promise<void>;

beforeEach(() => {
  localStorage.clear();
  useSessionPinnedStore.setState({ pins: {} });
  useSessionExpansionStore.setState({ expanded: {} });
  originalSessionLoad = useGlobalSessionsStore.getState().loadSessions;
  originalFolderLoad = useSessionFoldersStore.getState().load;
  useSessionFoldersStore.setState({ load: async () => undefined, foldersByDirectory: {}, collapsedFolderIds: {} });
  useGlobalSessionsStore.setState({ loadSessions: async () => undefined });
});
afterEach(async () => {
  act(() => root?.unmount());
  await switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionsStore.getState().reset();
  useGlobalSessionsStore.setState({ loadSessions: originalSessionLoad });
  useSessionFoldersStore.setState({ load: originalFolderLoad });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function session(id: string, title: string): Session {
  return { id, directory: 'D:/work', title, time: { created: 1, updated: 1 } } as Session;
}

function mount(rename: (sessionID: string, title: string) => Promise<void>): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ChatSidebar engine={{} as never} currentDirectory="D:/work" currentSessionId={null}
    actions={{ openDraft: () => undefined, openSession: () => undefined, rename,
      archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
  return container;
}

const realPrompt = window.prompt;

it('suggest-name asks the seam, then applies the confirmed suggestion through rename', async () => {
  useGlobalSessionsStore.setState({ active: [session('s1', '')], archived: [], hasLoaded: true, status: 'ready' });
  const rename = vi.fn(async () => undefined);
  const node = mount(rename);
  suggestFetch.impl = async (url) => {
    expect(url).toContain('/api/sessions/s1/suggest-name?directory=D%3A%2Fwork');
    return new Response(JSON.stringify({ name: 'Fix the login bug' }), { status: 200 });
  };
  const prompts: (string | undefined)[] = [];
  window.prompt = ((heading: string, fallback?: string) => { prompts.push(heading); return fallback; }) as typeof window.prompt;
  act(() => (node.querySelector('[data-testid="session-suggest-name"]') as HTMLButtonElement).click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(prompts[0]).toContain('Fix the login bug');
  expect(rename).toHaveBeenCalledWith('s1', 'Fix the login bug');
  window.prompt = realPrompt;
});

it('suggest-name surfaces the no-small-model failure without renaming', async () => {
  useGlobalSessionsStore.setState({ active: [session('s1', '')], archived: [], hasLoaded: true, status: 'ready' });
  const rename = vi.fn(async () => undefined);
  const node = mount(rename);
  suggestFetch.impl = async () => new Response(JSON.stringify({ error: 'no small model is available' }), { status: 503 });
  const prompts: string[] = [];
  window.prompt = ((heading: string) => { prompts.push(heading); return null; }) as typeof window.prompt;
  act(() => (node.querySelector('[data-testid="session-suggest-name"]') as HTMLButtonElement).click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(rename).not.toHaveBeenCalled();
  expect(prompts).toEqual([]);
  window.prompt = realPrompt;
});
