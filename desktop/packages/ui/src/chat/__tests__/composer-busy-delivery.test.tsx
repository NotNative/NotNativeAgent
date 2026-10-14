// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * F3 busy/denial delivery slice (doc 05 §B.9/§D.7/§F.4): NNA's busy verdict is
 * authoritative even against a stale idle view — the default follow-up re-routes
 * the unchanged draft through the server-owned queue (the distinct operation for
 * a running turn), a steer follow-up keeps the draft instead of being re-labelled,
 * a denied/failed send-path denial aborts the submit with the draft intact, and
 * an unconfirmed stop surfaces instead of claiming the turn stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }));

import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { toast } from 'sonner';
import { Composer } from '../composer.tsx';
import { __resetDraftStoreForTests } from '../drafts.ts';
import { __resetSettingsStoreForTests, useSettingsStore } from '../../lib/settings/store.ts';
import { __resetMessageQueueStoreForTests, useMessageQueueStore } from '../../stores/useMessageQueueStore.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';
import type { DirectoryStore } from '../../sync/types.ts';
import type { PermissionRequest } from '../../lib/nnd/types.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = runtimeFetch as unknown as Mock<(url: string, init?: { method?: string; body?: string }) => Promise<Response>>;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const PERMISSION: PermissionRequest = { id: 'p1', sessionID: 's1', permission: 'edit', patterns: [], metadata: {}, always: [] };

function storeStub(overrides: Partial<DirectoryStore> = {}): StoreApi<DirectoryStore> {
  const state = {
    command: [], agent: [], provider: [],
    config: { nnd: { engine: 'nna', primaryModel: { providerID: 'prov', modelID: 'model' } } },
    message: { s1: [] }, part: {}, permission: {}, question: {},
    session: [{ id: 's1', directory: '/proj', metadata: { nnd: { configuredModel: { providerID: 'prov', modelID: 'model' } } } }],
    patch: () => undefined, replace: () => undefined,
    ...overrides,
  } as unknown as DirectoryStore;
  return { subscribe: () => () => undefined, getState: () => state } as unknown as StoreApi<DirectoryStore>;
}

let engineSend: ReturnType<typeof vi.fn>;
let engineAbort: ReturnType<typeof vi.fn>;
let replyPermission: ReturnType<typeof vi.fn>;
let replyQuestion: ReturnType<typeof vi.fn>;
let queueEndpointClosed: boolean;

const services = (store: StoreApi<DirectoryStore>) => ({
  engine: {
    actions: {
      send: engineSend,
      abort: engineAbort,
      replyPermission,
      replyQuestion,
      createSession: vi.fn(),
    },
  } as never,
  store: () => store,
  dispatch: () => undefined,
});

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

function editor(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
}

async function renderComposer(store: StoreApi<DirectoryStore>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(<Composer services={services(store)} sessionID="s1" directory="/proj" sessionKey="s1" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typePending(value: string): Promise<void> {
  const target = editor();
  await act(async () => {
    nativeSet.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    editor().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** NNA's own busy refusal, shaped exactly as dispatchPrompt surfaces it. */
function busyError(): never {
  throw Object.assign(new Error('promptAsync failed (409): NND session already has an active turn'),
    { status: 409, transportTagged: false });
}

function queuePosts(): Array<Record<string, { content?: string }>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/message-queue/sessions/s1/items'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, { content?: string }>);
}

beforeEach(() => {
  __resetDraftStoreForTests();
  __resetSettingsStoreForTests();
  __resetMessageQueueStoreForTests();
  useGlobalSessionStatusStore.getState().reset();
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  queueEndpointClosed = false;
  engineSend = vi.fn(async () => undefined);
  engineAbort = vi.fn(async () => undefined);
  replyPermission = vi.fn(async () => undefined);
  replyQuestion = vi.fn(async () => undefined);
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const isQueuePost = String(url).includes('/api/message-queue/sessions/s1/items') && init?.method === 'POST';
    if (isQueuePost && queueEndpointClosed) {
      return jsonResponse({ error: 'native_alpha_surface_unavailable' }, false, 409);
    }
    if (isQueuePost) return jsonResponse({ revision: 2, itemId: 'queued-1' });
    if (String(url).includes('/api/message-queue')) return jsonResponse({ revision: 2, sessions: [] });
    return jsonResponse({});
  });
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

describe('busy refusal routes to the distinct queue operation (§B.9/§D.7)', () => {
  it('queues the unchanged draft when NNA answers busy against a stale idle view', async () => {
    await renderComposer(storeStub());
    engineSend.mockImplementation(busyError);
    await typePending('follow up while running');
    await pressEnter();

    expect(engineSend).toHaveBeenCalledTimes(1);
    const posts = queuePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!['item']!.content).toBe('follow up while running');
    expect(editor().value).toBe(''); // server accepted the queue: composer cleared
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the draft and narrates the steer refusal instead of re-labelling the choice', async () => {
    await renderComposer(storeStub());
    engineSend.mockImplementation(busyError);
    await act(async () => {
      useSettingsStore.setState({ doc: { followUpBehavior: 'steer' }, loading: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      useGlobalSessionStatusStore.getState().applyEvent('s1', { type: 'busy' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await typePending('steer this turn');
    await pressEnter();

    expect(engineSend).toHaveBeenCalledTimes(1);
    expect(engineSend.mock.calls[0]![0]).toMatchObject({ delivery: 'steer' });
    expect(queuePosts()).toHaveLength(0); // never silently re-labelled queue
    expect(editor().value).toBe('steer this turn'); // draft preserved
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Steer delivery was refused'));
  });

  it('restores the draft when the queue itself refuses the busy reroute', async () => {
    await renderComposer(storeStub());
    engineSend.mockImplementation(busyError);
    queueEndpointClosed = true;
    await typePending('blocked queue surface');
    await pressEnter();

    expect(editor().value).toBe('blocked queue surface');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('it stays in the composer'));
  });
});

describe('send-path denial outcomes (§F.4 authoritative deny)', () => {
  it('aborts the send when the permission denial cannot be delivered', async () => {
    const permission = { permission: { s1: [PERMISSION] } } as unknown as Partial<DirectoryStore>;
    await renderComposer(storeStub(permission));
    replyPermission.mockRejectedValue(new Error('denial transport failed'));
    await typePending('send through the blocker');
    await pressEnter();

    expect(replyPermission).toHaveBeenCalledWith('s1', expect.objectContaining({ id: 'p1' }), 'reject');
    expect(engineSend).not.toHaveBeenCalled(); // the send stopped at the failed denial
    expect(queuePosts()).toHaveLength(0); // nothing queued behind a failed denial
    expect(editor().value).toBe('send through the blocker'); // draft preserved
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Could not deny the pending permission request'));
  });

  it('denies then queues when the denial succeeds (happy authoritative path)', async () => {
    const permission = { permission: { s1: [PERMISSION] } } as unknown as Partial<DirectoryStore>;
    await renderComposer(storeStub(permission));
    await typePending('send through the blocker');
    await pressEnter();

    expect(replyPermission).toHaveBeenCalledWith('s1', expect.objectContaining({ id: 'p1' }), 'reject');
    expect(engineSend).not.toHaveBeenCalled(); // blocked sends never deliver directly
    expect(queuePosts()).toHaveLength(1);
    expect(editor().value).toBe('');
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('stop surfaces an unconfirmed abort (§B.11)', () => {
  it('narrates NNA refusing the stop instead of claiming the turn stopped', async () => {
    const store = storeStub();
    engineAbort.mockRejectedValue(new Error('nnd.session.abort permission missing'));
    await renderComposer(store);
    await act(async () => {
      useGlobalSessionStatusStore.getState().applyEvent('s1', { type: 'busy' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const stop = document.querySelector('[aria-label="Stop generating"]') as HTMLButtonElement;
    expect(stop).toBeTruthy();
    await act(async () => {
      stop.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(engineAbort).toHaveBeenCalledWith('s1');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('NNA did not confirm the stop'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('nnd.session.abort permission missing'));
  });

  it('stays silent when NNA confirms the stop', async () => {
    await renderComposer(storeStub());
    await act(async () => {
      useGlobalSessionStatusStore.getState().applyEvent('s1', { type: 'busy' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const stop = document.querySelector('[aria-label="Stop generating"]') as HTMLButtonElement;
    await act(async () => {
      stop.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(engineAbort).toHaveBeenCalledWith('s1');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
