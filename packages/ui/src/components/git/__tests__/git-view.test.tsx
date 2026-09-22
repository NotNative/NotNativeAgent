// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * GitView SLICE-B gates (doc 06 §6/§6.8 + §13#1): stage/unstage/discard
 * riding the optimistic queue with the published path hints, commit with
 * the message gate, the read-only History (log rows + maxCount steps +
 * Copy SHA) and Branches dialogs, and the 15 s visible cadence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(), success: vi.fn(), message: vi.fn(), dismiss: vi.fn(),
  }),
}));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { GitView } from '../GitView.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { useGitStore } from '../../../lib/git/store';
import { publishReviewRefresh, subscribeReviewRefresh, __resetReviewRefreshForTests, type ReviewRefreshHint } from '../../../lib/git/refresh-hints';

const fetchMock = runtimeFetch as unknown as Mock;
const DIR = '/repo';

const STATUS = {
  isGitRepository: true,
  branch: 'main',
  trackingAhead: 0,
  trackingBehind: 0,
  files: [
    { path: 'work.ts', index: ' ', working_dir: 'M' },
    { path: 'staged.ts', index: 'M', working_dir: ' ' },
  ],
};

const BRANCHES = { isGitRepository: true, current: 'main', local: ['main', 'feature/next'], remote: ['origin/main', 'origin/HEAD'] };

const LOG = {
  isGitRepository: true,
  commits: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'Dev', date: new Date(2026, 0, 15, 9, 30).getTime(), subject: 'first', files: 1, additions: 3, deletions: 1 },
    { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'Dev', date: new Date(2026, 0, 16).getTime(), subject: 'second', files: 2, additions: 4, deletions: 0 },
  ],
};

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function route(url: string): Response {
  if (url.includes('/api/git/status')) return jsonResponse(STATUS);
  if (url.includes('/api/git/branches')) return jsonResponse(BRANCHES);
  if (url.includes('/api/git/log')) return jsonResponse(LOG);
  return jsonResponse({});
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  fetchMock.mockImplementation(async (input: string) => route(String(input)));
  useGitStore.getState().__resetForTests();
  __resetReviewRefreshForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
  __resetReviewRefreshForTests();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <GitView directory={DIR} visible />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle(ms = 30): Promise<void> {
  await act(async () => { await new Promise((done) => setTimeout(done, ms)); });
}

function rowOf(path: string, scope: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="git-file-row"]')]
    .find((element) => element.dataset.path === path && element.getAttribute('data-scope') === scope);
  expect(row, `row ${scope}:${path} in ${document.body.textContent ?? ''}`).toBeDefined();
  return row!;
}

describe('GitView (doc 06 §6 v1)', () => {
  it('renders grouped sections and stages/unstages through the optimistic queue with hints', async () => {
    const hints: ReviewRefreshHint[] = [];
    const unsubscribe = subscribeReviewRefresh((hint) => hints.push(hint));
    try {
      await render();
      await settle();
      expect(rowOf('staged.ts', 'staged')).toBeDefined();
      expect(rowOf('work.ts', 'working')).toBeDefined();
      expect(document.querySelector('[data-path="clean.ts"]')).toBeNull(); // clean rows never render
      fetchMock.mockClear();
      await act(async () => {
        (rowOf('work.ts', 'working').querySelector('[data-testid="git-file-stage"]') as HTMLButtonElement).click();
        await new Promise((done) => setTimeout(done, 40));
      });
      const stageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/stage'));
      expect(stageCalls.length).toBe(1);
      expect(JSON.parse(String((stageCalls[0]![1] as RequestInit).body))).toEqual({ paths: ['work.ts'] });
      expect(hints.some((hint) => hint.reasons.includes('git-mutation') && hint.paths?.includes('work.ts'))).toBe(true);
      fetchMock.mockClear();
      await act(async () => {
        (rowOf('staged.ts', 'staged').querySelector('[data-testid="git-file-unstage"]') as HTMLButtonElement).click();
        await new Promise((done) => setTimeout(done, 40));
      });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/unstage')).length).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('discards through the confirm dialog against /api/git/discard', async () => {
    await render();
    await settle();
    fetchMock.mockClear();
    await act(async () => {
      (rowOf('work.ts', 'working').querySelector('[data-testid="git-file-revert-working"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 10));
    });
    expect(document.querySelector('[data-testid="git-revert-dialog"]')).not.toBeNull();
    await act(async () => {
      (document.querySelector('[data-testid="git-revert-confirm"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 40));
    });
    expect(document.querySelector('[data-testid="git-revert-dialog"]')).toBeNull();
    const discardCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/discard'));
    expect(discardCalls.length).toBe(1);
    expect(JSON.parse(String((discardCalls[0]![1] as RequestInit).body))).toEqual({ paths: ['work.ts'] });
  });

  it('commits with the message gate; empty messages keep the button disabled', async () => {
    await render();
    await settle();
    const { toast } = await import('sonner');
    fetchMock.mockClear();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const commitButton = (document.querySelector('[data-testid="git-commit"]') as HTMLButtonElement);
    expect(commitButton.disabled).toBe(true); // the gate is disabled until a message + staged files exist
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/commit')).length).toBe(0);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'feat: real commit');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('[data-testid="git-commit"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 40));
    });
    const commitCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/commit'));
    expect(commitCalls.length).toBe(1);
    expect(JSON.parse(String((commitCalls[0]![1] as RequestInit).body))).toEqual({ message: 'feat: real commit' });
    expect(toast.success).toHaveBeenCalledWith('Commit created');
  });

  it('shows the read-only history and branches dialogs from the git log/branch read family', async () => {
    await render();
    await settle();
    await act(async () => {
      (document.querySelector('[data-testid="git-open-history"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 30));
    });
    const history = document.querySelector('[data-testid="git-history-dialog"]');
    expect(history).not.toBeNull();
    expect(history!.textContent).toContain('first');
    expect(history!.textContent).toContain('second');
    expect(history!.textContent).toContain('Copy SHA');
    const rows = [...document.querySelectorAll('[data-testid="git-history-row"]')];
    expect(rows.length).toBe(2);
    await act(async () => {
      (document.querySelector('[aria-label="Close Commit history"]') as HTMLButtonElement).click();
      (document.querySelector('[data-testid="git-open-branches"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 30));
    });
    const branchesDialog = document.querySelector('[data-testid="git-branches-dialog"]');
    expect(branchesDialog).not.toBeNull();
    expect(branchesDialog!.textContent).toContain('feature/next');
    expect(branchesDialog!.textContent).toContain('origin/main');
    expect(branchesDialog!.textContent).toContain('Current');
  });

  it('replays refresh hints into a restat of the visible workbench', async () => {
    await render();
    await settle();
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length;
    expect(before).toBeGreaterThan(0);
    act(() => publishReviewRefresh(DIR, ['staged.ts'], 'fs-mutation'));
    await settle(40);
    const after = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('reconciles the status every 15 s while visible (§6.4 cadence)', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockClear();
      await act(async () => { await render(); });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length).toBeGreaterThan(0);
      fetchMock.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
