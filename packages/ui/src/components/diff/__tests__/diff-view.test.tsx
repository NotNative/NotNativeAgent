// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * DiffView v1 gates (doc 06 §5.3–§5.8, §11.3, §6.4): per-scope entry keying
 * (one file may render in BOTH stacks), scope selector, the >500 large-diff
 * gate with render-anyway, scope-aware hunk actions riding
 * /api/git/apply-hunk (single hunk, header carried), the published refresh
 * hint, and §13#1 hint replay (cache drop → re-fetch). Server traffic rides
 * the runtimeFetch mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { registerRuntimeAPIs } from '../../../lib/api/registry.ts';
import * as serverGit from '../../../lib/git/server-api.ts';
import type { RuntimeAPIs } from '../../../lib/api/types.ts';
import { publishReviewRefresh } from '../../../lib/git/refresh-hints';
import { DiffView } from '../DiffView.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { useGitStore } from '../../../lib/git/store';
import { subscribeReviewRefresh, __resetReviewRefreshForTests, type ReviewRefreshHint } from '../../../lib/git/refresh-hints';

const fetchMock = runtimeFetch as unknown as Mock;
const DIR = '/repo';
const FULL40_A = '1'.repeat(40);
const FULL40_B = '2'.repeat(40);
const FULL40_C = '3'.repeat(40);
const FULL40_D = '4'.repeat(40);

function workingPatch(path: string, insert: string, remove: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index ${FULL40_A}..${FULL40_B} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' keep',
    `-${remove}`,
    `+${insert}`,
  ].join('\n');
}

function stagedPatch(path: string, insert: string, remove: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index ${FULL40_C}..${FULL40_D} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' keep staged',
    `-${remove}`,
    `+${insert}`,
  ].join('\n');
}

const STATUS = {
  isGitRepository: true,
  branch: 'main',
  trackingAhead: 0,
  trackingBehind: 0,
  files: [
    { path: 'both.ts', index: 'M', working_dir: 'M' },
    { path: 'work.ts', index: ' ', working_dir: 'M' },
    { path: 'staged.ts', index: 'A', working_dir: ' ' },
    { path: 'huge.ts', index: ' ', working_dir: 'M' },
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

function hugePatch(path: string): string {
  const header = [`diff --git a/${path} b/${path}`, `index ${FULL40_A}..${FULL40_B} 100644`, `--- a/${path}`, `+++ b/${path}`];
  const lines: string[] = [];
  for (let i = 0; i < 300; i += 1) lines.push('-old');
  for (let i = 0; i < 260; i += 1) lines.push('+new');
  return [...header, '@@ -1,300 +1,300 @@', ...lines].join('\n'); // 560 changed lines
}

function route(url: string, init?: RequestInit): Response {
  if (url.includes('/api/git/status')) return jsonResponse(STATUS);
  if (url.includes('/api/git/diff')) {
    const staged = url.includes('staged=true');
    const path = decodeURIComponent(/path=([^&]+)/u.exec(url)?.[1] ?? '');
    if (path === 'huge.ts') return jsonResponse({ diff: hugePatch(path) });
    if (staged) return jsonResponse({ diff: stagedPatch(path, `new ${path}`, `old ${path}`) });
    return jsonResponse({ diff: workingPatch(path, `new ${path}`, `old ${path}`) });
  }
  if (url.includes('/api/git/apply-hunk')) expect(init?.body).toBeDefined();
  return jsonResponse({});
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  registerRuntimeAPIs({ git: serverGit } as unknown as RuntimeAPIs);
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => route(String(input), init));
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
});

async function render(focusPath?: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <DiffView directory={DIR} visible focusPath={focusPath} />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise((done) => setTimeout(done, ms)); });
}

function entriesOf(): Array<{ path: string; scope: string | null }> {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="diff-entry"]')]
    .map((section) => ({ path: section.dataset.path ?? '', scope: section.getAttribute('data-scope') }));
}

function clickRow(path: string): void {
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="diff-entry"]')]
    .find((section) => section.dataset.path === path);
  (row?.querySelector(`button[title="${path}"]`) as HTMLButtonElement | null)?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
}

describe('DiffView (doc 06 §5 v1)', () => {
  it('reveals a new staged-only link after the retained pane narrowed to Working', async () => {
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/status')
      ? jsonResponse({ ...STATUS, workspacePrefix: '' }) : route(String(input)));
    await render(); await settle();
    await act(async () => (document.querySelector('[data-testid="diff-scope-working"]') as HTMLButtonElement).click());
    expect(entriesOf().some((entry) => entry.path === 'staged.ts')).toBe(false);
    await act(async () => rootHandle!.render(<I18nProvider><DiffView directory={DIR} visible focusPath="staged.ts" focusRevision={2} /></I18nProvider>));
    await settle();
    expect(entriesOf().some((entry) => entry.path === 'staged.ts')).toBe(true);
    expect(document.body.textContent).not.toContain('linked file has no available diff');
  });
  it('reveals a linked nested-workspace file beyond default expansion and permits later collapse', async () => {
    const status = { ...STATUS, workspacePrefix: 'nested/', files: Array.from({ length: 12 }, (_, index) => ({ path: `nested/file${index}.ts`, index: ' ', working_dir: 'M' })) };
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => String(input).includes('/api/git/status') ? jsonResponse(status) : route(String(input), init));
    await render('file11.ts'); await settle();
    const target = [...document.querySelectorAll<HTMLElement>('[data-testid="diff-entry"]')].find((entry) => entry.dataset.path === 'nested/file11.ts')!;
    expect(target.querySelector('[data-testid="diff-viewer"]')).not.toBeNull();
    await act(async () => clickRow('nested/file11.ts'));
    expect(target.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    await act(async () => rootHandle!.render(<I18nProvider><DiffView directory={DIR} visible focusPath="file11.ts" focusRevision={2} /></I18nProvider>));
    await settle();
    expect(target.querySelector('[data-testid="diff-viewer"]')).not.toBeNull();
  });
  it('reports an unavailable linked file instead of selecting another diff', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => String(input).includes('/api/git/status') ? jsonResponse({ ...STATUS, workspacePrefix: '' }) : route(String(input), init));
    await render('missing.ts'); await settle();
    expect(container?.querySelector('[role="status"]')?.textContent).toContain('no available diff');
  });
  it('renders per-scope entries; one file can appear in BOTH stacks with its own diff', async () => {
    await render();
    const both = entriesOf().filter((entry) => entry.path === 'both.ts');
    expect(both.map((entry) => entry.scope).sort()).toEqual(['staged', 'working']);
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('keep staged'); // staged context only exists on the staged side
    expect(text).toContain('old work.ts'); // working-only entry fetched too
    expect(text).toContain('old both.ts'); // working removal for both.ts rendered
    expect(text).toContain('@@ -1,2 +1,2 @@');
  });

  it('the scope selector filters the stacked entries (all/working/staged)', async () => {
    await render();
    const pick = async (testid: string): Promise<void> => {
      await act(async () => {
        (document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement).click();
        await new Promise((done) => setTimeout(done, 10));
      });
    };
    await pick('diff-scope-working');
    expect(entriesOf().map((entry) => entry.scope)).toEqual(['working', 'working', 'working']);
    expect(entriesOf().map((entry) => entry.path).sort()).toEqual(['both.ts', 'huge.ts', 'work.ts']);
    await pick('diff-scope-staged');
    expect(entriesOf().map((entry) => entry.path).sort()).toEqual(['both.ts', 'staged.ts']);
    await pick('diff-scope-all');
    expect(entriesOf().length).toBe(5); // 2 stacks for both.ts + 3 working/staged rows
  });

  it('gates >500-line diffs behind the explicit render-anyway escape', async () => {
    await render(); // all four entries open by default expansion (§5.4)
    await settle();
    expect(document.querySelector('[data-testid="diff-large-gate"]')).not.toBeNull();
    let viewer: Element | null = null;
    await act(async () => {
      (document.querySelector('[data-testid="diff-render-anyway"]') as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 20));
      viewer = document.querySelector('[data-testid="diff-viewer"]');
    });
    expect(viewer).not.toBeNull();
    expect(document.querySelector('[data-testid="diff-large-gate"]')).toBeNull();
  });

  it('hunk actions are scope-aware and apply exactly one hunk; the result publishes a hint', async () => {
    const hints: ReviewRefreshHint[] = [];
    const unsubscribe = subscribeReviewRefresh((hint) => hints.push(hint));
    try {
      await render();
      await settle();
      const workingRow = [...document.querySelectorAll<HTMLElement>('[data-testid="diff-entry"]')]
        .find((section) => section.dataset.path === 'work.ts' && section.getAttribute('data-scope') === 'working') as HTMLElement;
      const stagedRow = [...document.querySelectorAll<HTMLElement>('[data-testid="diff-entry"]')]
        .find((section) => section.dataset.path === 'staged.ts' && section.getAttribute('data-scope') === 'staged') as HTMLElement;
      expect(workingRow.querySelector('[data-testid="diff-hunk-stage-0"]')).not.toBeNull();
      expect(workingRow.querySelector('[data-testid="diff-hunk-unstage-0"]')).toBeNull();
      expect(stagedRow.querySelector('[data-testid="diff-hunk-stage-0"]')).toBeNull();
      expect(stagedRow.querySelector('[data-testid="diff-hunk-unstage-0"]')).not.toBeNull();
      fetchMock.mockClear();
      await act(async () => {
        (workingRow.querySelector('[data-testid="diff-hunk-stage-0"]') as HTMLButtonElement).click();
        await new Promise((done) => setTimeout(done, 40));
      });
      const hunkCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/apply-hunk'));
      expect(hunkCalls.length).toBe(1);
      const body = JSON.parse(String((hunkCalls[0]![1] as RequestInit).body));
      expect(body.action).toBe('stage');
      expect(body.path).toBe('work.ts');
      expect((body.patch.match(/^@@ /gmu) ?? []).length).toBe(1);
      expect(body.patch.startsWith('diff --git a/work.ts b/work.ts')).toBe(true);
      await settle(10);
      expect(hints.some((hint) => hint.directory === DIR && hint.reasons.includes('git-mutation') && hint.paths?.includes('work.ts'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('replays refresh hints while visible: the touched path re-fetches', async () => {
    await render();
    await settle();
    const callsBefore = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/diff') && String(url).includes('work.ts')).length;
    expect(callsBefore).toBeGreaterThan(0);
    act(() => publishReviewRefresh(DIR, ['work.ts'], 'file-save'));
    await settle(40);
    const callsAfter = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/git/diff') && String(url).includes('work.ts')).length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });
});
