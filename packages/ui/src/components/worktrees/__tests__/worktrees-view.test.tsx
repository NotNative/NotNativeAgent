// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * WorktreesView live v1 gates (doc 06 §7): the topology from /api/git/
 * worktrees renders with per-card branch + remove only on LINKED entries;
 * the creation dialog posts mode 'new' and refreshes on success / stays +
 * toasts on failure; remove posts DELETE with the local branch kept and
 * the refreshed topology drops the card; list failure keeps the previous
 * topology on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { WorktreesView, useWorktreeOrderStore } from '../WorktreesView.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';

const fetchMock = runtimeFetch as unknown as Mock;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/repo';
const PRIMARY = { path: '/repo', head: 'abc1234', branch: 'main', detached: false, linked: false };
const LINKED = { path: '/wt/one', head: 'abc1234', branch: 'feat/one', detached: false, linked: true };

let createdWorktrees: { path: string; branch: string }[];
let postBody: Record<string, unknown> | null = null;
let deleteBody: Record<string, unknown> | null = null;
let createFails = false;
let postCount = 0;
let deleteCount = 0;
type DeferMode = '' | 'post' | 'delete' | 'gets';
let deferMode: DeferMode = '';
let heldPosts: (() => void)[] = [];
let heldDeletes: (() => void)[] = [];
let heldGets: (() => void)[] = [];

function entries(): unknown[] {
  const list = [PRIMARY, ...createdWorktrees.map((entry) => ({ ...LINKED, path: entry.path, branch: entry.branch }))];
  return list;
}

function trackResponse(response: Response, mode: DeferMode, pool: (() => void)[]): Promise<Response> {
  if (deferMode === mode) {
    return new Promise<Response>((resolve) => { pool.push(() => resolve(response)); });
  }
  return Promise.resolve(response);
}

function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.includes('/api/git/worktrees') && (init?.method === undefined || init.method === 'GET')) {
    const snapshot = entries(); // captured at REQUEST time: released later, the payload is point-in-time
    const response = jsonResponse({ worktrees: snapshot });
    if (deferMode === 'gets') {
      return new Promise<Response>((resolve) => { heldGets.push(() => resolve(response)); });
    }
    return Promise.resolve(response);
  }
  if (init?.method === 'POST') {
    postCount += 1;
    postBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    if (createFails) {
      return trackResponse(jsonResponse({ error: 'branch exists' }, 500), 'post', heldPosts);
    }
    createdWorktrees.push({ path: `/data/git-worktrees/repo/${String(postBody!['worktreeName'] ?? 'wt')}`, branch: String(postBody!['branchName'] ?? '') });
    return trackResponse(jsonResponse({ worktree: createdWorktrees[createdWorktrees.length - 1] }), 'post', heldPosts);
  }
  if (init?.method === 'DELETE') {
    deleteCount += 1;
    deleteBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    createdWorktrees = createdWorktrees.filter((entry) => entry.path !== deleteBody!['directory']);
    return trackResponse(jsonResponse({ success: true, branch: null }), 'delete', heldDeletes);
  }
  return Promise.resolve(jsonResponse({}));
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  createdWorktrees = [{ path: '/wt/one', branch: 'feat/one' }]; // linked topology on screen
  postBody = null;
  deleteBody = null;
  createFails = false;
  postCount = 0;
  deleteCount = 0;
  deferMode = '';
  heldPosts = [];
  heldDeletes = [];
  heldGets = [];
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => routeFetch(input, init));
  useWorktreeOrderStore.getState().__resetForTests();
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

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await Promise.resolve();
    }
  });
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(<I18nProvider><WorktreesFrame /></I18nProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function WorktreesFrame(): ReactNode {
  return <WorktreesView projectRoot={ROOT} onClose={() => undefined} />;
}

async function setNativeValue(field: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('WorktreesView live wiring (doc 06 §7 v1)', () => {
  it('renders the topology with branch chips and removes only on linked entries', async () => {
    await render();
    await flush();
    const cards = document.querySelectorAll('[data-testid="worktree-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('/repo');
    expect(cards[1]!.textContent).toContain('feat/one');
    expect(document.querySelectorAll('[data-testid="worktree-remove"]')).toHaveLength(1); // primary has no remove
  });

  it('the dialog posts mode new and the refreshed topology shows the worktree', async () => {
    await render();
    await flush();
    await act(async () => {
      (document.querySelector('[data-testid="worktrees-new"]') as HTMLElement).click();
      await Promise.resolve();
    });
    const dialog = document.querySelector('[data-testid="worktree-create-dialog"]');
    expect(dialog).not.toBeNull();
    await setNativeValue(document.querySelector('[data-testid="worktree-branch-input"]') as HTMLInputElement, 'feat/two');
    await act(async () => {
      (document.querySelector('[data-testid="worktree-create-submit"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(postBody).toEqual({ mode: 'new', branchName: 'feat/two' });
    expect(document.querySelector('[data-testid="worktree-create-dialog"]')).toBeNull(); // closed on success
    expect(document.querySelectorAll('[data-testid="worktree-card"]')).toHaveLength(3);
    const cards = [...document.querySelectorAll('[data-testid="worktree-card"]')];
    expect(cards.some((card) => card.textContent?.includes('feat/two'))).toBe(true); // known paths first, unknown alphabetical (§7)
  });

  it('a failed create keeps the dialog open, changes nothing, and persists the exact code path', async () => {
    await render();
    await flush();
    createFails = true;
    await act(async () => {
      (document.querySelector('[data-testid="worktrees-new"]') as HTMLElement).click();
      await Promise.resolve();
    });
    await setNativeValue(document.querySelector('[data-testid="worktree-branch-input"]') as HTMLInputElement, 'dup');
    await act(async () => {
      (document.querySelector('[data-testid="worktree-create-submit"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(document.querySelector('[data-testid="worktree-create-dialog"]')).not.toBeNull(); // failure keeps the dialog
    expect(document.querySelectorAll('[data-testid="worktree-card"]')).toHaveLength(2); // topology untouched
  });

  it('remove posts DELETE with the local branch kept and refreshes the topology', async () => {
    createdWorktrees = [{ path: '/wt/one', branch: 'feat/one' }];
    await render();
    await flush();
    expect(document.querySelectorAll('[data-testid="worktree-remove"]')).toHaveLength(1);
    await act(async () => {
      (document.querySelector('[data-testid="worktree-remove"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(deleteBody).toEqual({ directory: '/wt/one', deleteLocalBranch: false });
    const cards = document.querySelectorAll('[data-testid="worktree-card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('/repo');
  });

  it('the create submit is single-flight: a second click while the POST pends posts exactly once', async () => {
    await render();
    await flush();
    await act(async () => {
      (document.querySelector('[data-testid="worktrees-new"]') as HTMLElement).click();
      await Promise.resolve();
    });
    await setNativeValue(document.querySelector('[data-testid="worktree-branch-input"]') as HTMLInputElement, 'feat/two');
    deferMode = 'post';
    await act(async () => {
      (document.querySelector('[data-testid="worktree-create-submit"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="worktree-create-dialog"]')?.textContent).toContain('Creating'); // busy label owns the button
    await act(async () => {
      (document.querySelector('[data-testid="worktree-create-submit"]') as HTMLElement).click(); // spam click while pending
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postCount).toBe(1); // the pending POST owns the submit
    deferMode = '';
    await act(async () => { heldPosts[0]?.(); });
    await flush();
    expect(postCount).toBe(1);
    expect(document.querySelector('[data-testid="worktree-create-dialog"]')).toBeNull(); // success still closes
    expect(document.querySelectorAll('[data-testid="worktree-card"]')).toHaveLength(3);
  });

  it('remove is single-flight while a DELETE pends: a second click fires no second DELETE', async () => {
    await render();
    await flush();
    deferMode = 'delete';
    await act(async () => {
      (document.querySelector('[data-testid="worktree-remove"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector('[data-testid="worktree-remove"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deleteCount).toBe(1); // the pending DELETE owns the remove button
    deferMode = '';
    await act(async () => { heldDeletes[0]?.(); });
    await flush();
    expect(deleteCount).toBe(1);
    expect(document.querySelectorAll('[data-testid="worktree-card"]')).toHaveLength(1); // /wt/one is gone
  });

  it('a stale refresh response cannot overwrite the newest topology (create/remove refresh race)', async () => {
    await render();
    await flush(); // GET#0 applied: 2 cards
    deferMode = 'gets'; // both mutation refreshes (post-delete, post-create) are held
    // DELETE /wt/one, then create feat/two; both refresh LIST calls are held:
    // refresh#1 (post-delete snapshot) and refresh#2 (post-create snapshot).
    await act(async () => {
      (document.querySelector('[data-testid="worktree-remove"]') as HTMLElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector('[data-testid="worktrees-new"]') as HTMLElement).click();
      await Promise.resolve();
    });
    await setNativeValue(document.querySelector('[data-testid="worktree-branch-input"]') as HTMLInputElement, 'feat/two');
    await act(async () => {
      (document.querySelector('[data-testid="worktree-create-submit"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush(); // refresh#2 now held with the post-create snapshot
    deferMode = '';
    await act(async () => { heldGets[1]?.(); }); // newest refresh applies first
    await flush();
    expect(document.querySelectorAll('[data-testid="worktree-card"]')).toHaveLength(2); // /repo + feat/two
    await act(async () => { heldGets[0]?.(); }); // the STALE post-delete snapshot lands LAST
    await flush();
    const cards = document.querySelectorAll('[data-testid="worktree-card"]');
    expect(cards).toHaveLength(2); // discarded: the newest topology must win
    expect([...cards].some((card) => card.textContent?.includes('feat/two'))).toBe(true);
    expect(document.querySelector('[data-testid="worktree-create-dialog"]')).toBeNull(); // the create still finished
  });

  it('a failed boot list shows the error, not the empty-tooling label (doc 03 #61 keep-topology rule)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, 500));
    await render();
    await flush();
    expect(document.querySelector('[data-testid="worktrees-view"]')?.textContent).toContain('Error');
    expect(document.querySelector('[data-testid="worktrees-view"]')?.textContent).not.toContain('No worktrees for this project');
  });
});
