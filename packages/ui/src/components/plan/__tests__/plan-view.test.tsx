// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * PlanView flow gates (doc 06 §8.1/§8.3): stable session-path identity,
 * 350 ms autosave, §8.3 switch/unmount flush that never crosses documents,
 * §8.2 failed-write surface + exact-revision retry, §8.1 pendingFor-on-
 * reopen (post-write read). Server traffic rides the runtimeFetch mock.
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
import { PlanView, sessionPlanFile } from '../PlanView.tsx';
import { sessionPlanPath, planEpochFor } from '../../../lib/plan/save-queue.ts';
import { I18nProvider } from '../../I18nProvider.tsx';
import { __resetDraftsForTests, draftKeyFor, useInlineCommentDrafts } from '../../../lib/comments/drafts.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { FOCUS_EVENT_NAME } from '../../comments/focus-chat.ts';

const fetchMock = runtimeFetch as unknown as Mock;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT_A = 'plan A text\n';

let writeBodyLog: { directory: string; path: string; content: string }[] = [];
let orderLog: string[] = [];
let writeHold: ((response: Response) => void) | null = null;
let writesShouldFail = false;

function pathOf(url: string): string {
  return new URLSearchParams(String(url).split('?')[1] ?? '').get('path') ?? '';
}
function directoryOf(url: string): string {
  return new URLSearchParams(String(url).split('?')[1] ?? '').get('directory') ?? '';
}

function routeFetch(input: string, init?: RequestInit): Response | Promise<Response> {
  const url = String(input);
  if (url.includes('/api/fs/read')) {
    orderLog.push(`read:${directoryOf(url)}:${pathOf(url)}`);
    if (directoryOf(url) === '/proj-a') {
      return { ok: true, status: 200, text: async () => CONTENT_A } as unknown as Response;
    }
    if (directoryOf(url) === '/proj-e') return errorResponse(403, { error: 'Access denied' });
    if (directoryOf(url) === '/proj-f') return errorResponse(404, { error: 'Not Found' });
    return errorResponse(404, { error: 'File not found', reason: 'not-found' }); // missing plan: blank
  }
  if (url.includes('/api/fs/write')) {
    orderLog.push(`write:${directoryOf(url)}:${pathOf(url)}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as { path: string; content: string };
    writeBodyLog.push({ directory: directoryOf(url), path: body.path, content: body.content });
    if (writeHold !== null) {
      return new Promise<Response>((resolve) => { writeHold = resolve; });
    }
    if (writesShouldFail) {
      return failResponse({ error: 'disk boom' }); // carries clone() so the client reads the error body
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

function failResponse(body: unknown): Response {
  return errorResponse(500, body);
}

function errorResponse(status: number, body: unknown): Response {
  const response = { ok: false, status, json: async () => body } as Response & { clone?: () => unknown };
  response.clone = () => response; // runtimeFetch's readError() clones before parsing
  return response as unknown as Response;
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
  writeBodyLog = [];
  orderLog = [];
  writeHold = null;
  writesShouldFail = false;
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => routeFetch(input, init));
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

async function render(directory: string, visible = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <PlanView directory={directory} visible={visible} />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function planPath(directory: string): string {
  return sessionPlanPath(directory, planEpochFor(directory), 'plan');
}

async function rerenderDirectory(next: string): Promise<void> {
  await act(async () => {
    rootHandle!.render(
      <I18nProvider>
        <PlanView directory={next} visible />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function type(text: string): Promise<void> {
  const textarea = document.querySelector('[data-plan-host] textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function flushTimers(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}

describe('PlanView flow (doc 06 §8 subset)', () => {
  it('resolves the SAME deterministic session path across mounts and loads its content', async () => {
    await render('/proj-a');
    const expected = planPath('/proj-a');
    expect(orderLog).toContain(`read:/proj-a:${expected}`);
    const textarea = document.querySelector('[data-plan-host] textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CONTENT_A);
    const second = sessionPlanFile('/proj-a', 'x').path;
    expect(second).toBe(expected); // stable identity: an authored plan is found again (P1-4)
  });

  it('autosaves the edit after 350 ms to the session plan path', async () => {
    await render('/proj-b');
    await type('first draft\n');
    expect(writeBodyLog).toHaveLength(0); // still debouncing
    await flushTimers(500);
    expect(writeBodyLog).toEqual([{ directory: '/proj-b', path: planPath('/proj-b'), content: 'first draft\n' }]);
    expect(document.querySelector('[data-testid="plan-save-status"]')?.textContent).toBe('Saved');
  });

  it('does not treat denied or unknown-endpoint reads as blank plans to overwrite', async () => {
    for (const directory of ['/proj-e', '/proj-f']) {
      await render(directory);
      const status = document.querySelector('[data-testid="plan-save-status"]') as HTMLElement;
      expect(status.textContent).toBe('Load failed');
      expect((document.querySelector('[data-plan-host] textarea') as HTMLTextAreaElement).disabled).toBe(true);
      expect(([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save now') as HTMLButtonElement).disabled).toBe(true);
      await flushTimers(500);
      expect(writeBodyLog).toHaveLength(0);
      await act(async () => rootHandle?.unmount());
      rootHandle = null;
      container?.remove();
      container = null;
    }
  });

  it('flushes the OLD buffer on switch and never lets a stale debounce cross documents', async () => {
    await render('/proj-a');
    await type('AAA-B\n'); // edit doc A; debounce pending
    await rerenderDirectory('/proj-b'); // switch INSIDE the debounce window
    await flushTimers(600);
    const writes = writeBodyLog;
    expect(writes).toEqual([{ directory: '/proj-a', path: planPath('/proj-a'), content: 'AAA-B\n' }]); // A kept its own content on its own path
    const textarea = document.querySelector('[data-plan-host] textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(''); // B resolved to a fresh blank plan
  });

  it('surfaces Save failed with the full message and retries the exact revision', async () => {
    await render('/proj-c');
    await type('retry me\n');
    writesShouldFail = true;
    await flushTimers(500);
    const status = document.querySelector('[data-testid="plan-save-status"]') as HTMLElement;
    expect(status.textContent).toBe('Save failed'); // §8.4: truncated label…
    expect(status.title).toBe('disk boom'); // …title = full message
    expect(writeBodyLog).toHaveLength(1);
    writesShouldFail = false;
    const saveButton = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save now');
    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeBodyLog).toHaveLength(2); // exact-revision retry (§8.2)
    expect(writeBodyLog[1]!.content).toBe('retry me\n');
    expect(status.textContent).toBe('Saved');
  });

  it('§8.1: a re-open awaits its own in-flight write and reads post-write state', async () => {
    await render('/proj-d');
    await type('in flight\n');
    writeHold = () => undefined; // absorber: the AUTOSAVE write itself stays in flight until released
    await flushTimers(500);
    const reads = () => orderLog.filter((entry) => entry.startsWith('read:'));
    expect(reads()).toHaveLength(1); // only the first mount read so far
    await act(async () => {
      rootHandle?.unmount(); // close-time flush dedups into the in-flight attempt (§8.2)
    });
    rootHandle = null;
    expect(reads()).toHaveLength(1);
    await render('/proj-d'); // re-open while the write is still in flight
    expect(reads()).toHaveLength(1); // pendingFor(blocking): the read waits for the write
    const hold = writeHold;
    writeHold = null;
    await act(async () => {
      hold?.({ ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reads()[1]).toBe(`read:/proj-d:${planPath('/proj-d')}`); // post-write read (§8.1)
    expect(orderLog.indexOf(`write:/proj-d:${planPath('/proj-d')}`)).toBeLessThan(orderLog.indexOf(`read:/proj-d:${planPath('/proj-d')}`, 1));
  });

  it('§10.2 v1: a plan selection becomes a plan-source comment with markdown language and the focus handoff', async () => {
    __resetDraftsForTests();
    useSessionViewStore.setState({ currentSessionId: 'ses_plan', activeDirectory: '/proj-a' });
    let focusEvents = 0;
    const onFocus = (): void => { focusEvents += 1; };
    window.addEventListener(FOCUS_EVENT_NAME, onFocus);
    await render('/proj-a');
    const textarea = document.querySelector('[data-plan-host] textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.setSelectionRange(0, 6); // 'plan A' on line 0
      (document.querySelector('[data-testid="plan-add-comment"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = document.querySelector('[data-comment-input] textarea') as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input!, 'tighten this wording');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector('[data-testid="comment-save"]') as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const slot = useInlineCommentDrafts.getState().store[draftKeyFor('/proj-a', 'ses_plan')]?.drafts ?? [];
    expect(slot).toHaveLength(1);
    expect(slot[0]!.source).toBe('plan');
    expect(slot[0]!.language).toBe('markdown');
    expect(slot[0]!.code).toBe('plan A text');
    expect(slot[0]!.fileLabel).toBe(planPath('/proj-a').split(/[\\/]/u).pop()); // the resolved plan file's basename
    expect(focusEvents).toBe(1); // §10.2 #4
    expect(document.querySelectorAll('[data-comment-card]')).toHaveLength(1);
    window.removeEventListener(FOCUS_EVENT_NAME, onFocus);
  });
});
