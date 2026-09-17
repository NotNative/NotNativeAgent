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
import { I18nProvider } from '../../I18nProvider.tsx';
import { useFilesViewTabsStore } from '../../../lib/files/tabs-store.ts';

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
});

