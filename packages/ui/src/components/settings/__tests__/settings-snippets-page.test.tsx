// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Snippets settings page pins (P9-4e-ii): roster render, CRUD over the
 * mocked config-entity client with verbatim refusal toasts, the client
 * name-pattern guard, shared-roster republish after each change, and the
 * refresh button. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(), success: vi.fn(), message: vi.fn(), dismiss: vi.fn(),
  }),
}));
vi.mock('../../../lib/snippets-api.ts', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, listSnippets: vi.fn(), getSnippet: vi.fn(), createSnippet: vi.fn(),
    patchSnippet: vi.fn(), deleteSnippet: vi.fn(), expandSnippet: vi.fn(),
  };
});

import { createSnippet, deleteSnippet, listSnippets, patchSnippet } from '../../../lib/snippets-api.ts';
import { __resetSnippetsSourceForTests, snippetMap } from '../../../lib/snippets-source.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { SnippetsPage } from '../pages/snippets.tsx';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const list = listSnippets as unknown as Mock;
const create = createSnippet as unknown as Mock;
const patch = patchSnippet as unknown as Mock;
const remove = deleteSnippet as unknown as Mock;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function settle(ms = 20): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<I18nProvider><SnippetsPage /></I18nProvider>); });
}

afterEach(() => {
  if (rootHandle !== null) { const closing = rootHandle; act(() => { closing.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
});

function setNative(selector: string, value: string): Promise<void> {
  const node = document.querySelector(selector) as HTMLInputElement;
  return act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function click(testid: string): void {
  act(() => {
    document.querySelector(`[data-testid="${testid}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const ROSTER = { ok: true as const, snippets: [
  { name: 'sig', text: 'sig-text', scope: 'global' },
  { name: 'heb', text: 'heb-text', scope: 'global' },
] };

beforeEach(() => {
  __resetSnippetsSourceForTests();
  list.mockReset().mockResolvedValue(ROSTER);
  create.mockReset().mockResolvedValue({ ok: true, success: true, snippet: { name: 'sig2', text: 'two', scope: 'global' } });
  patch.mockReset().mockResolvedValue({ ok: true, success: true, snippet: { name: 'sig', text: 'new-text', scope: 'global' } });
  remove.mockReset().mockResolvedValue({ ok: true, success: true });
});

describe('snippets settings page', () => {
  it('renders the roster rows with names and texts', async () => {
    mount();
    await act(async () => { await settle(); });
    const names = [...document.querySelectorAll('[data-testid="snippets-name"]')].map((node) => node.textContent);
    expect(names).toEqual(['#sig', '#heb']);
    const texts = [...document.querySelectorAll('[data-testid="snippets-text"]')].map((node) => node.textContent);
    expect(texts).toEqual(['sig-text', 'heb-text']);
  });

  it('a refused list folds to the alert line; the refresh button reloads', async () => {
    list.mockResolvedValue({ ok: false, status: 500, error: 'snippet request failed (500)' });
    mount();
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('snippet request failed (500)');
    list.mockResolvedValue(ROSTER);
    click('snippets-refresh');
    await act(async () => { await settle(); });
    expect(document.querySelectorAll('[data-testid="snippets-row"]').length).toBe(2);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a malformed 200 without the roster folds to the alert line', async () => {
    // Defect probe: the page trusted `outcome.snippets` after `outcome.ok`
    // (apiJson stamps ok on ANY 200 body). A malformed response set the
    // roster state to undefined and the page rendered BLANK - neither the
    // alert line nor the empty hint. Shape-hostile folds refuse like a
    // refused request.
    list.mockResolvedValue({ ok: true });
    mount();
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('snippet response was malformed');
    expect(document.querySelectorAll('[data-testid="snippets-row"]').length).toBe(0);
  });

  it('a malformed 200 with non-record items folds to the alert line', async () => {
    list.mockResolvedValue({ ok: true, snippets: ['not a snippet'] });
    mount();
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('snippet response was malformed');
    expect(document.querySelectorAll('[data-testid="snippets-row"]').length).toBe(0);
  });

  it('create rides the client, republishes the shared roster, and reloads', async () => {
    mount();
    await act(async () => { await settle(); });
    await setNative('[data-testid="snippets-new-name"]', 'sig2');
    await setNative('[data-testid="snippets-new-text"]', 'two');
    // the reload + the shared-roster refresh both ride THIS list mock
    list.mockResolvedValue({ ok: true, snippets: [...ROSTER.snippets, { name: 'sig2', text: 'two', scope: 'global' }] });
    click('snippets-create');
    await act(async () => { await settle(); });
    expect(create).toHaveBeenCalledWith('sig2', { text: 'two' });
    expect(toast.success).toHaveBeenCalledWith('snippet saved');
    expect(snippetMap().get('sig2')).toBe('two');
    expect(list.mock.calls.length).toBe(3); // initial effect + page reload + shared refresh
  });

  it('an invalid name answers the client pattern string without a request', async () => {
    mount();
    await act(async () => { await settle(); });
    await setNative('[data-testid="snippets-new-name"]', 'bad.name');
    await setNative('[data-testid="snippets-new-text"]', 'x');
    click('snippets-create');
    await act(async () => { await settle(); });
    expect(toast.error).toHaveBeenCalledWith('snippet name must match [\\w-]{1,64}');
    expect(create).not.toHaveBeenCalled();
  });

  it('a refused create keeps the form values and answers the server verbatim', async () => {
    create.mockResolvedValue({ ok: false, status: 409, error: 'snippet exists' });
    mount();
    await act(async () => { await settle(); });
    await setNative('[data-testid="snippets-new-name"]', 'sig');
    await setNative('[data-testid="snippets-new-text"]', 'again');
    click('snippets-create');
    await act(async () => { await settle(); });
    expect(toast.error).toHaveBeenCalledWith('snippet exists');
    expect((document.querySelector('[data-testid="snippets-new-name"]') as HTMLInputElement).value).toBe('sig');
    expect(list.mock.calls.length).toBe(1);
  });

  it('an edit refolded by a vanished record keeps the row drafting and answers the 404 verbatim', async () => {
    mount();
    await act(async () => { await settle(); });
    const row = document.querySelectorAll('[data-testid="snippets-row"]')[0]!;
    act(() => {
      row.querySelector('[data-testid="snippets-edit"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    patch.mockResolvedValue({ ok: false, status: 404, error: 'snippet not found' });
    act(() => {
      row.querySelector('[data-testid="snippets-save"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await settle(); });
    expect(patch).toHaveBeenCalledWith('sig', { text: 'sig-text' });
    expect(toast.error).toHaveBeenCalledWith('snippet not found');
    // the row stays in edit mode with the draft; the page does not reload
    expect(row.querySelector('[data-testid="snippets-edit-text"]')).not.toBeNull();
    expect(list.mock.calls.length).toBe(1);
  });

  it('edit swaps to inputs; save PATCHes the stored name', async () => {
    mount();
    await act(async () => { await settle(); });
    const row = document.querySelectorAll('[data-testid="snippets-row"]')[0]!;
    act(() => {
      row.querySelector('[data-testid="snippets-edit"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const field = row.querySelector('[data-testid="snippets-edit-text"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, 'new-text');
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'sig', text: 'new-text', scope: 'global' }, { name: 'heb', text: 'heb-text', scope: 'global' }] });
    act(() => {
      row.querySelector('[data-testid="snippets-save"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await settle(); });
    expect(patch).toHaveBeenCalledWith('sig', { text: 'new-text' });
    expect(snippetMap().get('sig')).toBe('new-text');
  });

  it('delete rides the client and the row leaves after the reload', async () => {
    mount();
    await act(async () => { await settle(); });
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'heb', text: 'heb-text', scope: 'global' }] });
    act(() => {
      (document.querySelector('[data-testid="snippets-row"] [data-testid="snippets-delete"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await settle(); });
    expect(remove).toHaveBeenCalledWith('sig');
    expect(toast.success).toHaveBeenCalledWith('snippet deleted');
    const names = [...document.querySelectorAll('[data-testid="snippets-name"]')].map((node) => node.textContent);
    expect(names).toEqual(['#heb']);
  });
});
