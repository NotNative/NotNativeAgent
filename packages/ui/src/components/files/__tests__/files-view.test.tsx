// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * FilesView flow gates (doc 06 §2.5-§2.7/§3.5/§3.7): the deliveries that
 * make the §3.7 autosave contract observable — dirty edit → debounced save
 * with no-store semantics; the no-cancel unsaved guard on uncloseable tab
 * close; and delete-confirm handling. Server traffic rides the runtimeFetch
 * mock (read/stat/list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { FilesView } from '../FilesView.tsx';
import { FileTree } from '../FileTree.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { useFilesViewTabsStore } from '../../../lib/files/tabs-store.ts';
import { __resetDraftsForTests, draftKeyFor, useInlineCommentDrafts } from '../../../lib/comments/drafts.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { FOCUS_EVENT_NAME } from '../../comments/focus-chat.ts';

const fetchMock = runtimeFetch as unknown as Mock;
const DIR = '/repo';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function route(url: string): Response {
  if (url.includes('/api/fs/list')) {
    return jsonResponse({ path: DIR, entries: [{ name: 'a.ts', path: `${DIR}/a.ts`, isDirectory: false, isFile: true }] });
  }
  if (url.includes('/api/fs/stat')) {
    return jsonResponse({ path: `${DIR}/a.ts`, isFile: true, exists: true, size: 6, mtimeMs: 100 });
  }
  if (url.includes('/api/fs/read')) {
    return new Response('hello\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return jsonResponse({});
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  fetchMock.mockImplementation(async (input: string) => route(String(input)));
  window.__NOTNATIVE_RUNTIME_KEY__ = undefined;
  useFilesViewTabsStore.getState().__resetForTests();
  useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/a.ts`, 'local');
  window.localStorage.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

afterEach(() => {
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <FilesView directory={DIR} visible />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FilesView flow (doc 06 §2/§3 v1)', () => {
  it('can render a read-only tree without creation or mutation controls', async () => {
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><FileTree root={DIR} runtimeKey="local" visible
      onOpenFile={() => undefined} onNewFile={() => undefined} onNewFolder={() => undefined}
      onRename={() => undefined} onDelete={() => undefined} readOnly /></I18nProvider>); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="files-tree"]')).not.toBeNull();
    expect(document.querySelector('button[title="/repo/a.ts"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="a.ts"]')).toBeNull();
    expect(document.querySelector('button[aria-label="New file"]')).toBeNull();
    expect(document.querySelector('button[aria-label="New folder"]')).toBeNull();
  });

  it('does not run a pending search while hidden, then searches when revealed', async () => {
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const tree = (visible: boolean) => <I18nProvider><FileTree root={DIR} runtimeKey="local" visible={visible}
      onOpenFile={() => undefined} onNewFile={() => undefined} onNewFolder={() => undefined}
      onRename={() => undefined} onDelete={() => undefined} readOnly /></I18nProvider>;
    await act(async () => { rootHandle!.render(tree(true)); await Promise.resolve(); });
    const input = document.querySelector('input[aria-label]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rootHandle!.render(tree(false)); });
    await act(async () => { await new Promise((done) => setTimeout(done, 250)); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/search'))).toBe(false);
    await act(async () => { rootHandle!.render(tree(true)); });
    await act(async () => { await new Promise((done) => setTimeout(done, 250)); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/search'))).toBe(true);
  });

  it('clears a root-list error after a successful retry', async () => {
    let fail = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/api/fs/list') && fail) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
      return route(String(input));
    });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><FileTree root={DIR} runtimeKey="local" visible
      onOpenFile={() => undefined} onNewFile={() => undefined} onNewFolder={() => undefined}
      onRename={() => undefined} onDelete={() => undefined} readOnly /></I18nProvider>); });
    await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
    expect(container.textContent).toContain('offline');
    fail = false;
    await act(async () => { ([...container!.querySelectorAll('button')].find((button) => button.textContent === 'Retry') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('offline');
    expect(container.querySelector('button[title="/repo/a.ts"]')).not.toBeNull();
  });

  it('loads the selected file into the editor and autosaves the edit after 1.5 s', async () => {
    await render();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('hello\n');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'hello world\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 1_800));
    });
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    const writeCall = calls.find((url) => url.includes('/api/fs/write'));
    expect(writeCall, `saw ${JSON.stringify(calls)}`).toBeDefined();
    const writeIndex = calls.findIndex((url) => url.includes('/api/fs/write'));
    const init = fetchMock.mock.calls[writeIndex]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ path: `${DIR}/a.ts`, content: 'hello world\n' });
    expect(document.body.textContent).toContain('Saved');
  });

  it('closing a DIRTY tab opens the no-cancel guard; discard reverts and closes', async () => {
    await render();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'changed\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const closeButtons = [...document.querySelectorAll('button')].filter(
      (node) => node.getAttribute('aria-label')?.startsWith('Close ') ?? false,
    );
    await act(async () => {
      closeButtons[0]!.click();
      await Promise.resolve();
    });
    const guard = document.querySelector('[data-testid="unsaved-guard"]');
    expect(guard).not.toBeNull(); // §2.7: no cancel path. Save or Discard only.
    expect(guard?.textContent).toContain('Save your edits before continuing?');
    const discard = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Discard');
    await act(async () => {
      discard!.click();
      await Promise.resolve();
    });
    expect(useFilesViewTabsStore.getState().byRoot[DIR]!.openPaths.length).toBe(0);
  });

  it('§10.2 v1: the selection becomes a file-source comment with extracted code and a focus handoff', async () => {
    __resetDraftsForTests();
    useSessionViewStore.setState({ currentSessionId: 'ses_files', activeDirectory: DIR });
    let focusEvents = 0;
    const onFocus = (): void => { focusEvents += 1; };
    window.addEventListener(FOCUS_EVENT_NAME, onFocus);
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    // 'hello\n' — select "hello" (offsets 0..5 → line 0)
    await act(async () => {
      textarea.setSelectionRange(0, 5);
      (document.querySelector('[data-testid="files-add-comment"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = document.querySelector('[data-comment-input] textarea') as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input!, 'this word looks wrong');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector('[data-testid="comment-save"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const slot = useInlineCommentDrafts.getState().store[draftKeyFor(DIR, 'ses_files')]?.drafts ?? [];
    expect(slot).toHaveLength(1);
    expect(slot[0]!.source).toBe('file');
    expect(slot[0]!.code).toBe('hello');
    expect(slot[0]!.startLine).toBe(0);
    expect(focusEvents).toBe(1); // §10.2 #4
    expect(document.querySelectorAll('[data-comment-card]')).toHaveLength(1);
    window.removeEventListener(FOCUS_EVENT_NAME, onFocus);
  });
});

