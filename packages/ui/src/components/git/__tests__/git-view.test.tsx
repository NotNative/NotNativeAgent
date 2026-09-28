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
import type { GitStatus } from '../../../lib/git/api.ts';
import { I18nProvider } from '../../I18nProvider.tsx';
import { useGitStore } from '../../../lib/git/store';
import { commitDraftScope, useCommitDraftStore } from '../../../lib/git/commit-drafts.ts';
import { publishReviewRefresh, subscribeReviewRefresh, __resetReviewRefreshForTests, type ReviewRefreshHint } from '../../../lib/git/refresh-hints';

const fetchMock = runtimeFetch as unknown as Mock;
const DIR = '/repo';

const STATUS = {
  isGitRepository: true,
  workspacePrefix: '',
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
  if (url.includes('/api/git/sync')) return jsonResponse({ synced: true, branch: 'main', pulled: false, pushed: true });
  if (url.includes('/api/git/diff')) {
    const path = new URL(url, 'http://localhost').searchParams.get('path') ?? 'work.ts';
    return jsonResponse({ diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` });
  }
  return jsonResponse({});
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  fetchMock.mockImplementation(async (input: string) => route(String(input)));
  useGitStore.getState().__resetForTests();
  __resetReviewRefreshForTests();
  useCommitDraftStore.setState({ drafts: {} });
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

async function render(compact = false): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <GitView directory={DIR} visible compact={compact} />
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
  it('restores a commit draft across workspace remounts and full/compact views without crossing runtimes', async () => {
    await render(true);
    const scope = commitDraftScope('local', DIR);
    const otherScope = commitDraftScope('local', '/other');
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} compact draftScope={scope} /></I18nProvider>); });
    await settle();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'Keep this work');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useCommitDraftStore.getState().drafts[scope]).toBe('Keep this work');
    await act(async () => { rootHandle!.render(<I18nProvider><GitView key="other" directory="/other" draftScope={otherScope} /></I18nProvider>); });
    await settle();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await act(async () => { rootHandle!.render(<I18nProvider><GitView key="back" directory={DIR} draftScope={scope} /></I18nProvider>); });
    await settle();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep this work');
    await act(async () => { rootHandle!.render(<I18nProvider><GitView key="remote" directory={DIR} draftScope={commitDraftScope('remote', DIR)} /></I18nProvider>); });
    await settle();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('hides the previous repository rows and preview while a new directory loads', async () => {
    await render();
    await settle();
    await act(async () => {
      (rowOf('work.ts', 'working').querySelector('[data-testid="git-file-name"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-testid="git-file-preview"]')).not.toBeNull();
    const releaseNewStatuses: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.includes('/api/git/status') && url.includes('directory=%2Fother')) {
        return new Promise<Response>((resolve) => { releaseNewStatuses.push(resolve); });
      }
      return route(url);
    });
    act(() => {
      rootHandle!.render(<I18nProvider><GitView directory="/other" visible /></I18nProvider>);
    });
    expect(document.querySelector('[data-testid="git-view-loading"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="git-file-row"]')).toBeNull();
    expect(document.querySelector('[data-testid="git-file-preview"]')).toBeNull();
    expect(releaseNewStatuses.length).toBeGreaterThan(0);
    await act(async () => { for (const release of releaseNewStatuses) release(jsonResponse({ ...STATUS, files: [
      { path: 'other.ts', index: ' ', working_dir: 'M' },
    ] })); });
    await settle();
    expect(rowOf('other.ts', 'working')).toBeDefined();
    expect(document.querySelector('[data-path="work.ts"]')).toBeNull();
    expect(document.querySelector('[data-testid="git-file-preview"]')).toBeNull();
  });

  it('offers a retry when the first status request fails instead of checking forever', async () => {
    let failing = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/api/git/status') && failing) return jsonResponse({ error: 'offline' }, false);
      return route(String(input));
    });
    await render();
    await settle();
    expect(document.querySelector('[data-testid="git-status-error"]')?.textContent).toContain('Could not load Git status');
    expect(document.querySelector('[data-testid="git-view-loading"]')).toBeNull();
    failing = false;
    await act(async () => { (document.querySelector('[data-testid="git-status-error"] button') as HTMLButtonElement).click(); });
    await settle();
    expect(rowOf('work.ts', 'working')).toBeDefined();
    expect(document.querySelector('[data-testid="git-status-error"]')).toBeNull();
  });

  it('shows a workspace-scoped recovery state after a failed directory switch', async () => {
    await render();
    await settle();
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/api/git/status') && String(input).includes('directory=%2Fother')) throw new Error('offline');
      return route(String(input));
    });
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory="/other" visible /></I18nProvider>); });
    await settle();
    expect(document.querySelector('[data-testid="git-status-error"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="git-file-row"]')).toBeNull();
  });

  it('disables Git mutations while the visible status is stale and restores them after retry', async () => {
    vi.useFakeTimers();
    await render();
    let failing = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/api/git/status') && failing) return jsonResponse({ error: 'offline' }, false);
      return route(String(input));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
    expect(document.querySelector('[data-testid="git-status-stale"]')).not.toBeNull();
    expect((rowOf('work.ts', 'working').querySelector('[data-testid="git-file-stage"]') as HTMLButtonElement).disabled).toBe(true);
    expect((rowOf('work.ts', 'working').querySelector('[data-testid="git-file-revert-working"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-testid="git-changes-primary"]')).toBeNull();
    expect((document.querySelector('[data-testid="git-sync"]') as HTMLButtonElement).disabled).toBe(true);
    failing = false;
    let releaseRetry: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/api/git/status')) return new Promise<Response>((resolve) => { releaseRetry = resolve; });
      return route(String(input));
    });
    // Simulate another Git surface populating the shared five-second cache.
    // Explicit Retry must still make a fresh request before enabling changes.
    useGitStore.getState().applyStatus(DIR, STATUS as GitStatus, 'light');
    act(() => { (document.querySelector('[data-testid="git-status-stale"] button') as HTMLButtonElement).click(); });
    expect(releaseRetry).toBeDefined();
    expect(document.querySelector('[data-testid="git-status-stale"]')).not.toBeNull();
    expect((rowOf('work.ts', 'working').querySelector('[data-testid="git-file-stage"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { releaseRetry!(jsonResponse(STATUS)); });
    expect(document.querySelector('[data-testid="git-status-stale"]')).toBeNull();
    expect((rowOf('work.ts', 'working').querySelector('[data-testid="git-file-stage"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens a read-only per-file diff from the filename; staging remains an explicit separate action', async () => {
    await render(true);
    await settle();
    fetchMock.mockClear();
    await act(async () => {
      (rowOf('work.ts', 'working').querySelector('[data-testid="git-file-name"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await settle();
    const preview = document.querySelector('[data-testid="git-file-preview"]') as HTMLElement;
    expect(preview.dataset.path).toBe('work.ts');
    expect(preview.dataset.scope).toBe('working');
    expect(preview.textContent).toContain('old');
    expect(preview.textContent).toContain('new');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/git/stage')
      || String(url).includes('/api/git/unstage'))).toBe(false);
    await act(async () => {
      (rowOf('staged.ts', 'staged').querySelector('[data-testid="git-file-name"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await settle();
    expect((document.querySelector('[data-testid="git-file-preview"]') as HTMLElement).dataset.scope).toBe('staged');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/git/diff') && String(url).includes('staged=true'))).toBe(true);
    act(() => (document.querySelector('button[aria-label="Close diff preview"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="git-file-preview"]')).toBeNull();
  });

  it('opens an authored Activity review path only when it is still in current Changes', async () => {
    await render(true);
    await settle();
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} visible compact
      reviewRequest={{ directory: DIR, path: 'work.ts', id: 1 }} /></I18nProvider>); await Promise.resolve(); });
    await settle();
    expect((document.querySelector('[data-testid="git-file-preview"]') as HTMLElement).dataset.path).toBe('work.ts');
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} visible compact
      reviewRequest={{ directory: DIR, path: 'gone.ts', id: 2 }} /></I18nProvider>); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="git-file-preview"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('no longer in current Changes');
  });

  it('checks fresh Git status for an Activity jump instead of trusting a recent cached snapshot', async () => {
    await render(true);
    await settle();
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/status')
      ? jsonResponse({ ...STATUS, files: [...STATUS.files, { path: 'new.ts', index: ' ', working_dir: 'M' }] })
      : route(String(input)));
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} visible compact
      reviewRequest={{ directory: DIR, path: 'new.ts', id: 3 }} /></I18nProvider>); await Promise.resolve(); });
    await settle();
    expect((document.querySelector('[data-testid="git-file-preview"]') as HTMLElement).dataset.path).toBe('new.ts');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/git/status')
      && String(url).includes('mode=light'))).toBe(true);
  });

  it('maps a nested workspace review path into porcelain repository-root paths', async () => {
    await render(true);
    await settle();
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/status')
      ? jsonResponse({ ...STATUS, workspacePrefix: 'packages/ui/', files: [
        { path: 'packages/ui/src/check.js', index: ' ', working_dir: 'M' },
      ] }) : route(String(input)));
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} visible compact
      reviewRequest={{ directory: DIR, path: 'src/check.js', id: 5 }} /></I18nProvider>); await Promise.resolve(); });
    await settle();
    expect((document.querySelector('[data-testid="git-file-preview"]') as HTMLElement).dataset.path)
      .toBe('packages/ui/src/check.js');
  });

  it('does not claim a review file disappeared when the fresh status request fails', async () => {
    await render(true);
    await settle();
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/status')
      ? jsonResponse({ error: 'temporary failure' }, false) : route(String(input)));
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} visible compact
      reviewRequest={{ directory: DIR, path: 'work.ts', id: 4 }} /></I18nProvider>); await Promise.resolve(); });
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Could not check current Changes');
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain('no longer');
  });

  it('keeps Changes, the selected diff, and commit controls in separate bounded scroll regions', async () => {
    await render(true);
    await settle();
    expect(document.querySelector('[data-testid="git-view"] > div')?.className).toContain('flex-col');
    const changes = document.querySelector('[data-testid="git-changes-scroll"]') as HTMLElement;
    const review = document.querySelector('[data-testid="git-review-scroll"]') as HTMLElement;
    const commit = document.querySelector('[data-testid="git-commit-dock"]') as HTMLElement;
    const aside = document.querySelector('[data-testid="git-view"] aside') as HTMLElement;
    expect(changes.className).toContain('overflow-y-auto');
    expect(aside.className).toContain('max-h-[55%]');
    expect(aside.className).toContain('overflow-hidden');
    expect(review.className).toContain('overflow-y-auto');
    expect(commit.className).toContain('shrink-0');
    expect(review.parentElement).toBe(aside);
    expect(commit.parentElement).toBe(aside);
    await act(async () => {
      (rowOf('work.ts', 'working').querySelector('[data-testid="git-file-name"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await settle();
    expect(review.querySelector('[data-testid="git-file-preview"]')).not.toBeNull();
    expect(commit.querySelector('[data-testid="git-commit"]')).not.toBeNull();
  });

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

  it('shows file counts and collapses each Changes group without hiding its bulk action', async () => {
    await render();
    await settle();
    const stagedToggle = document.querySelector('[data-testid="git-staged-toggle"]') as HTMLButtonElement;
    const changesToggle = document.querySelector('[data-testid="git-changes-toggle"]') as HTMLButtonElement;
    expect(stagedToggle.textContent).toContain('Staged 1');
    expect(changesToggle.textContent).toContain('Changes 1');
    expect(stagedToggle.getAttribute('aria-expanded')).toBe('true');
    act(() => stagedToggle.click());
    expect(stagedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-path="staged.ts"]')).toBeNull();
    expect(rowOf('work.ts', 'working')).toBeDefined();
    expect(document.querySelector('[data-testid="git-staged-primary"]')).not.toBeNull();
    act(() => changesToggle.click());
    expect(document.querySelector('[data-path="work.ts"]')).toBeNull();
    act(() => { stagedToggle.click(); changesToggle.click(); });
    expect(rowOf('staged.ts', 'staged')).toBeDefined();
    expect(rowOf('work.ts', 'working')).toBeDefined();
  });

  it('shows honest upstream and ahead/behind state in a compact branch header', async () => {
    let projected: GitStatus = { ...STATUS, upstream: null, upstreamGone: false };
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/status')
      ? jsonResponse(projected) : route(String(input)));
    await render(true);
    await settle();
    expect(document.querySelector('[data-testid="git-tracking"]')?.textContent).toBe('No upstream');
    expect(document.querySelector('[data-testid="git-sync"]')?.parentElement?.className).toContain('w-full');
    projected = { ...STATUS, branch: 'feature', upstream: 'origin/feature', upstreamGone: false, trackingAhead: 2, trackingBehind: 1 };
    act(() => publishReviewRefresh(DIR, null, 'git-mutation'));
    await settle();
    expect(document.querySelector('[data-testid="git-branch"]')?.textContent).toBe('feature');
    expect(document.querySelector('[data-testid="git-tracking"]')?.textContent).toBe('↑2 ↓1');
    projected = { ...STATUS, branch: 'feature', upstream: 'origin/feature', upstreamGone: true };
    act(() => publishReviewRefresh(DIR, null, 'git-mutation'));
    await settle();
    expect(document.querySelector('[data-testid="git-tracking"]')?.textContent).toBe('Upstream missing');
    projected = { ...STATUS, branch: null, upstream: null, upstreamGone: false };
    act(() => publishReviewRefresh(DIR, null, 'git-mutation'));
    await settle();
    expect(document.querySelector('[data-testid="git-branch"]')?.textContent).toBe('Detached HEAD');
    expect(document.querySelector('[data-testid="git-tracking"]')).toBeNull();
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

  it('uses a real sync request after Commit & sync and also offers a standalone retry', async () => {
    await render();
    await settle();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'feat: sync me');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Commit & sync') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 40));
    });
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.findIndex((url) => url.includes('/api/git/commit'))).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((url) => url.includes('/api/git/sync'))).toBeGreaterThan(calls.findIndex((url) => url.includes('/api/git/commit')));
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('Commit created and synced');
    fetchMock.mockClear();
    await act(async () => { (document.querySelector('[data-testid="git-sync"]') as HTMLButtonElement).click(); await new Promise((done) => setTimeout(done, 40)); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/git/sync'))).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Branch synced');
  });

  it('reports a committed-but-unsynced result instead of claiming the remote changed', async () => {
    const { toast } = await import('sonner');
    vi.mocked(toast.success).mockClear();
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/sync')
      ? jsonResponse({ error: 'Configure an upstream branch before syncing' }, false) : route(String(input)));
    await render();
    await settle();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'feat: local only');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Commit & sync') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 40));
    });
    expect(toast.error).toHaveBeenCalledWith('Commit created locally; sync failed: Configure an upstream branch before syncing');
    expect(toast.success).not.toHaveBeenCalledWith('Commit created and synced');
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('reports a rejected commit and retains its scoped draft for retry', async () => {
    const scope = commitDraftScope('local', DIR);
    useCommitDraftStore.getState().setDraft(scope, 'feat: retry me');
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/commit')
      ? jsonResponse({ error: 'commit rejected' }, false) : route(String(input)));
    await render();
    await act(async () => { rootHandle!.render(<I18nProvider><GitView directory={DIR} draftScope={scope} /></I18nProvider>); });
    await settle();
    await act(async () => {
      (document.querySelector('[data-testid="git-commit"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 30));
    });
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalledWith('Failed to create commit');
    expect(useCommitDraftStore.getState().drafts[scope]).toBe('feat: retry me');
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('feat: retry me');
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
