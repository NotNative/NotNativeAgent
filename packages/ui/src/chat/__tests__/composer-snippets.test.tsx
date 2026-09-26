// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Composer `#` snippet picker riding the config-entity roster (P9-4e-ii):
 * the mount refresh publishes the server snippets, typing `#si` lists them
 * through the REAL runtimeFetch pipeline (only the native fetch seam is
 * stubbed via vi.hoisted), picking inserts `#sig ` with the composer's
 * trailing-space convention, and a failed roster load keeps the picker at
 * 'No matches' silently (unknown tokens keep their bytes).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { Composer } from '../composer.tsx';
import { __resetDraftStoreForTests } from '../drafts.ts';
import type { DirectoryStore } from '../../sync/types.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => {
  const globalScope = globalThis as { fetch?: typeof fetch };
  const previous = globalScope.fetch;
  const native = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>();
  globalScope.fetch = native as unknown as typeof fetch;
  return { native, previous };
});

const native = hoisted.native;
const EMPTY_SNAPSHOT = {
  command: [], agent: [], provider: [], message: {}, part: {}, permission: {}, question: {},
} as unknown as DirectoryStore;
const storeStub = { subscribe: () => () => undefined, getState: () => EMPTY_SNAPSHOT } as unknown as StoreApi<DirectoryStore>;
const services = { engine: {} as never, store: () => storeStub, dispatch: () => undefined };

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

function settle(ms = 30): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<Composer services={services} sessionID={null} directory='C:/repo' sessionKey='draft' />); });
}

async function typeIn(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    nativeSet.call(textarea, value);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Deferred fsSearch plumbing: resolvers keyed by the request's `query`, so a
 * test can land a response AFTER later keystrokes (the real browser order the
 * per-render token counter gets wrong). */
let fsResolvers = new Map<string, (response: Response) => void>();

function routeFsDeferred(): void {
  fsResolvers = new Map();
  native.mockImplementation((input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/api/fs/search')) {
      const query = new URLSearchParams(url.slice(url.indexOf('?'))).get('query') ?? '';
      return new Promise<Response>((resolve) => { fsResolvers.set(query, resolve); });
    }
    if (url.includes('/api/config/snippets')) return Promise.resolve(answer(200, { snippets: [] }));
    return Promise.resolve(answer(404, { error: 'quiet' }));
  });
}

function resolveFs(query: string, entries: { path: string }[]): void {
  const resolve = fsResolvers.get(query)!;
  fsResolvers.delete(query);
  resolve(answer(200, { entries }));
}

function clickPickerItem(label: string): void {
  act(() => {
    ([...document.querySelectorAll('[data-testid="composer-picker"] button')])
      .find((button) => button.textContent === label)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  if (rootHandle !== null) { const closing = rootHandle; act(() => { closing.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
});

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = hoisted.previous;
});

describe('composer # picker over the snippet roster (real transport)', () => {
  it('roster-fed picker lists server snippets and inserts with a trailing space', async () => {
    native.mockImplementation((input: RequestInfo) => Promise.resolve(
      String(input).includes('/api/config/snippets')
        ? answer(200, { snippets: [{ name: 'sig', text: 'r' }, { name: 'todo', text: 'r' }] })
        : answer(404, { error: 'quiet' }),
    ));
    __resetDraftStoreForTests();
    mount();
    await act(async () => { await settle(); });
    const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
    await typeIn(editor, 'send #si');
    const picker = document.querySelector('[data-testid="composer-picker"]');
    expect(picker?.textContent).toContain('sig');
    await act(async () => {
      ([...document.querySelectorAll('[data-testid="composer-picker"] button')])
        .find((button) => button.textContent === 'sig')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('send #sig ');
    expect(document.querySelector('[data-testid="composer-picker"]')).toBeNull();
  });

  it('a failed roster load keeps the picker honest and the draft untouched', async () => {
    native.mockResolvedValue(answer(500, { error: 'snippet request failed (500)' }));
    __resetDraftStoreForTests();
    mount();
    await act(async () => { await settle(); });
    const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
    await typeIn(editor, 'x #nope');
    const picker = document.querySelector('[data-testid="composer-picker"]');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain('No matches');
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('x #nope');
  });

  it('a stale fsSearch response from a prior token publishes nothing into the newer picker', async () => {
    // Defect probe: `triggerMentionToken` was a per-render `let`, so each
    // keystroke's fsSearch closed over a FRESH frame (value 1) and the guard
    // compared a response against its own frame forever - a no-op. The late
    // '@ma' response must not repopulate the '@mas' picker.
    routeFsDeferred();
    __resetDraftStoreForTests();
    mount();
    await act(async () => { await settle(); });
    const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
    await typeIn(editor, 'check @ma');
    await typeIn(editor, 'check @mas');
    resolveFs('ma', [{ path: 'mascot.ts' }]);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).not.toContain('mascot.ts');
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('check @mas');
    // positive control: the CURRENT token's own response still lands and binds
    // the full current span (fresh merge survives the hoisted counter).
    resolveFs('mas', [{ path: 'mascot.ts' }]);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).toContain('mascot.ts');
    clickPickerItem('mascot.ts');
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('check @mascot.ts ');
  });

  it('a mention search repurposed as a snippet token merges no file results', async () => {
    // Defect probe: the merge guard compared tokenStart only. Same span start,
    // different KIND: the pending '@ma' search must not repopulate the '#ma'
    // snippet picker or bind a mention insert to a '#' token (editor parity).
    routeFsDeferred();
    __resetDraftStoreForTests();
    mount();
    await act(async () => { await settle(); });
    const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
    await typeIn(editor, 'check @ma');
    await typeIn(editor, 'check #ma');
    resolveFs('ma', [{ path: 'mascot.ts' }]);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).not.toContain('mascot.ts');
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).toContain('No matches');
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('check #ma');
  });

  it('a late fsSearch response does not resurrect the picker after an insert', async () => {
    // Defect probe: applyPick cleared the picker STATE but left pickerRef
    // current.value serving the stale entry, so a late stale response merged
    // against it and REPUBLISHED a closed picker (zombie list after send prep).
    routeFsDeferred();
    __resetDraftStoreForTests();
    mount();
    await act(async () => { await settle(); });
    const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
    await typeIn(editor, 'check @ma');
    await typeIn(editor, 'check @mas');
    resolveFs('mas', [{ path: 'mascot.ts' }]);
    await act(async () => { await settle(); });
    clickPickerItem('mascot.ts');
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('check @mascot.ts ');
    expect(document.querySelector('[data-testid="composer-picker"]')).toBeNull();
    resolveFs('ma', [{ path: 'mascot.ts' }]);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="composer-picker"]')).toBeNull();
    expect((document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement).value).toBe('check @mascot.ts ');
  });
});
