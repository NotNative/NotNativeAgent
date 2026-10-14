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
import { registerRuntimeAPIs } from '../../../lib/api/registry.ts';
import * as serverFiles from '../../../lib/files/server-api.ts';
import * as serverGit from '../../../lib/git/server-api.ts';
import type { RuntimeAPIs } from '../../../lib/api/types.ts';
import { FilesView } from '../FilesView.tsx';
import { FileTree } from '../FileTree.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { useFilesViewTabsStore } from '../../../lib/files/tabs-store.ts';
import { __resetDraftLeasesForTests, readDraftLease } from '../../../lib/files/draft-leases.ts';
import { getRuntimeKey } from '../../../lib/runtime-switch.ts';
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
  registerRuntimeAPIs({ git: serverGit, files: {
    listDirectory: serverFiles.listDirectory, search: serverFiles.searchWorkspaceFiles,
    readFileStat: serverFiles.readFileStat, readFileText: serverFiles.readFileText,
    writeFileText: serverFiles.writeFileText, rawAssetUrl: serverFiles.rawAssetUrl,
    createDirectory: serverFiles.createDirectory, deleteEntry: serverFiles.deleteEntry,
    renameEntry: serverFiles.renameEntry,
  } } as unknown as RuntimeAPIs);
  fetchMock.mockImplementation(async (input: string) => route(String(input)));
  window.__NOTNATIVE_RUNTIME_KEY__ = undefined;
  // Why: the suite paces component debounce timers only; shouldAdvanceTime keeps
  // real microtasks (fetch mocks) flowing while the sleeps become instant advances.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useFilesViewTabsStore.getState().__resetForTests();
  __resetDraftLeasesForTests();
  useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/a.ts`, 'local');
  window.localStorage.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
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
      onRename={() => undefined} onDelete={() => undefined} readOnly /></I18nProvider>);
      await vi.advanceTimersByTimeAsync(50); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/search'))).toBe(false);
    await act(async () => { rootHandle!.render(tree(true)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
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
      await vi.advanceTimersByTimeAsync(1_800);
    });
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    const writeCall = calls.find((url) => url.includes('/api/fs/write'));
    expect(writeCall, `saw ${JSON.stringify(calls)}`).toBeDefined();
    const writeIndex = calls.findIndex((url) => url.includes('/api/fs/write'));
    const init = fetchMock.mock.calls[writeIndex]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ path: `${DIR}/a.ts`, content: 'hello world\n', expectedContent: 'hello\n' });
    expect(document.body.textContent).toContain('Saved');
  });

  it('keeps a normal draft and pauses autosave after a server content conflict', async () => {
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/write')
      ? new Response(JSON.stringify({ error: 'File changed since it was opened', reason: 'content-conflict' }), { status: 409 })
      : route(String(input)));
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'my edit\n'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('my edit\n');
    expect(document.querySelector('[data-testid="files-recovered-draft"]')?.textContent).toContain('changed on disk');
    expect(document.body.textContent).toContain('Manual save');
    expect(readDraftLease(getRuntimeKey(), DIR, `${DIR}/a.ts`)?.draft).toBe('my edit\n');
  });

  it('reports an unverifiable guarded write without retrying autosave', async () => {
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/write')
      ? new Response(JSON.stringify({ error: 'File could not be verified before saving', reason: 'content-conflict', safety: 'unknown' }), { status: 409 })
      : route(String(input)));
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'my edit\n'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="files-recovered-draft"]')?.textContent).toContain('could not be verified');
    expect(document.body.textContent).toContain('Manual save');
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('my edit\n');
  });

  it('does not start overlapping editor saves against one baseline', async () => {
    let finishWrite: ((response: Response) => void) | null = null;
    const writesBefore = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/fs/write')).length;
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/write')
      ? await new Promise<Response>((resolve) => { finishWrite = resolve; })
      : route(String(input)));
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'first edit\n'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(finishWrite).not.toBeNull();
    await act(async () => { setter.call(textarea, 'second edit\n'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/fs/write'))).toHaveLength(writesBefore + 1);
    await act(async () => { finishWrite!(jsonResponse({ success: true })); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('second edit\n');
    expect(document.body.textContent).toContain('Unsaved');
  });

  it('does not apply an old save completion to a newly selected file', async () => {
    let finishWrite: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/write')
      ? await new Promise<Response>((resolve) => { finishWrite = resolve; })
      : route(String(input)));
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'first edit\n'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(finishWrite).not.toBeNull();
    await act(async () => { useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/b.ts`, 'local'); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('hello\n');
    await act(async () => { finishWrite!(jsonResponse({ success: true })); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('hello\n');
    expect(document.body.textContent).not.toContain('Unsaved');
  });

  it('restores a draft after Files unmounts and pauses its pending auto-save', async () => {
    await render();
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'kept draft\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rootHandle!.unmount(); });
    rootHandle = createRoot(container!);
    await act(async () => { rootHandle!.render(<I18nProvider><FilesView directory={DIR} visible /></I18nProvider>); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('kept draft\n');
    expect(document.querySelector('[data-testid="files-recovered-draft"]')?.textContent).toContain('Unsaved edits restored');
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_700); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/write'))).toBe(false);
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/write'))).toBe(true);
  });

  it('blocks a recovered draft from overwriting a changed disk file until explicit confirmation', async () => {
    await render();
    await act(async () => { ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Auto-save on') as HTMLButtonElement).click(); });
    const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'my draft\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rootHandle!.unmount(); });
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/stat')
      ? jsonResponse({ path: `${DIR}/a.ts`, isFile: true, exists: true, size: 10, mtimeMs: 200 }) : route(String(input)));
    rootHandle = createRoot(container!);
    await act(async () => { rootHandle!.render(<I18nProvider><FilesView directory={DIR} visible /></I18nProvider>); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="files-recovered-draft"]')?.textContent).toContain('changed on disk');
    fetchMock.mockClear();
    await act(async () => { (document.querySelector('[data-testid="save-now"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/write'))).toBe(false);
    await act(async () => { ([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Overwrite disk with draft')) as HTMLButtonElement).click(); });
    await act(async () => {
      const field = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
      setter.call(field, 'my revised draft\n');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Confirm overwrite')).toBe(false);
    await act(async () => { ([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Overwrite disk with draft')) as HTMLButtonElement).click(); });
    await act(async () => { ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Confirm overwrite') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/write'))).toBe(true);
  });

  it('keeps a recovered draft when discard-and-reload fails, then discards after a successful read', async () => {
    await render();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      const textarea = document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement;
      setter.call(textarea, 'draft to keep\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rootHandle!.unmount(); });
    rootHandle = createRoot(container!);
    await act(async () => { rootHandle!.render(<I18nProvider><FilesView directory={DIR} visible /></I18nProvider>); await Promise.resolve(); });
    expect(readDraftLease(getRuntimeKey(), DIR, `${DIR}/a.ts`)?.draft).toBe('draft to keep\n');

    let failRead = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (failRead && String(input).includes('/api/fs/read')) return new Response(JSON.stringify({ error: 'temporarily offline' }), { status: 503 });
      return route(String(input));
    });
    const discard = (): void => {
      ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Discard draft & reload') as HTMLButtonElement).click();
    };
    await act(async () => { discard(); await Promise.resolve(); });
    expect(readDraftLease(getRuntimeKey(), DIR, `${DIR}/a.ts`)?.draft).toBe('draft to keep\n');
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('draft to keep\n');
    expect(document.querySelector('[data-testid="files-recovered-draft"]')).not.toBeNull();

    failRead = false;
    await act(async () => { discard(); await Promise.resolve(); });
    expect((document.querySelector('[data-editor-host] textarea') as HTMLTextAreaElement).value).toBe('hello\n');
    expect(readDraftLease(getRuntimeKey(), DIR, `${DIR}/a.ts`)).toBeNull();
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

  it('renders a markdown file through the hardened preview in view mode', async () => {
    useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/notes.md`, 'local');
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/read')
      ? new Response('# Title\n\nplain body\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : route(String(input)));
    await render();
    const toggle = document.querySelector('[title="Switch to preview"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(document.querySelector('h3')?.textContent).toBe('Title');
    expect(document.body.textContent).toContain('plain body');
  });

  it('falls back to the raw text stage for malformed JSON previews', async () => {
    useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/data.json`, 'local');
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/read')
      ? new Response('{bad json', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : route(String(input)));
    await render();
    const toggle = document.querySelector('[title="Switch to preview"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(document.querySelector('pre')?.textContent).toBe('{bad json');
  });

  it('opens a PDF in the embedded viewer pane instead of the binary card', async () => {
    useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/doc.pdf`, 'local');
    await render();
    const frame = document.querySelector('iframe[title="PDF preview"]') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toContain('doc.pdf');
    expect(frame.getAttribute('sandbox')).toBe(''); // pins the fully-sandboxed viewer
    expect(document.body.textContent).toContain('Save file');
  });

  it('pretty-prints valid JSON in view mode without touching the draft', async () => {
    useFilesViewTabsStore.getState().setSelectedPath(DIR, `${DIR}/data.json`, 'local');
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/fs/read')
      ? new Response('{"b":1,"a":[2,3]}', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : route(String(input)));
    await render();
    const toggle = document.querySelector('[title="Switch to preview"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.textContent).toBe('{\n  "b": 1,\n  "a": [\n    2,\n    3\n  ]\n}');
  });
});
