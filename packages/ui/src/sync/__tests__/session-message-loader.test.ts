// SPDX-License-Identifier: Apache-2.0
/**
 * Loader gates (doc 04 §E.1) with the harness client mocked: in-flight share,
 * prefetch→initial promotion, underfill expansion, tail refresh that never
 * clobbers the coverage cursor, queued refreshes behind in-flight loads,
 * generation rejection, and initializeCreatedSession empty-claim supersede.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => 'test-runtime',
  onRuntimeEndpointChanged: () => () => undefined,
  DEFAULT_RUNTIME_KEY: 'url:test-runtime',
  deriveRuntimeKey: (value: string) => `url:${value}`,
  isTransientRuntimeKey: () => false,
  getApiBaseUrlActive: () => null,
  initializeRuntimeEndpoint: () => undefined,
  transformRuntime: () => undefined,
  switchRuntime: () => undefined,
  registerRuntimeLifecycle: () => () => undefined,
  onRuntimeReset: () => () => undefined,
  configureRuntimeKeys: () => undefined,
}));

import { configureHarness, callsFor } from './harness-client-mock.ts';
import { SessionMessageLoader, mergePartsPreservingTerminal, type LoaderTarget } from '../session-message-loader.ts';
import { INITIAL_STATE, type DirectoryStore } from '../types.ts';

function target(directory = 'D:/work', sessionID = 's1'): { store: StoreApi<DirectoryStore>; target: LoaderTarget } {
  const store = createStore<DirectoryStore>(() => ({
    ...JSON.parse(JSON.stringify(INITIAL_STATE)) as unknown as DirectoryStore,
    patch: () => undefined,
    replace: () => undefined,
  }));
  return { store, target: { directory, sessionID, store } };
}

function entries(count: number, role: 'user' | 'assistant' = 'user'): { info: { id: string; sessionID: string; role: string; time: { created: number } }; parts: [] }[] {
  return Array.from({ length: count }, (_, index) => ({
    info: { id: `m${index}`, sessionID: 's1', role, time: { created: index * 10 } },
    parts: [],
  }));
}

beforeEach(() => {
  configureHarness({});
});

describe('loader behavior', () => {
  it('replaces optimistic text when a server part uses a different ID', () => {
    const draft = { id: 'draft', messageID: 'm1', sessionID: '', type: 'text', text: 'same text' } as never;
    const tool = { id: 'tool', messageID: 'm1', sessionID: 's1', type: 'tool', state: { status: 'completed' } } as never;
    const settled = { id: 'server', messageID: 'm1', sessionID: 's1', type: 'text', text: 'same text' } as never;
    expect(mergePartsPreservingTerminal([draft, tool], [settled])).toEqual([tool, settled]);
    expect(mergePartsPreservingTerminal([draft, tool], [])).toEqual([draft, tool]);
  });

  it('shares ONE in-flight request across callers', async () => {
    configureHarness({
      listMessagesPage: () => ({ data: entries(2), response: { status: 200 } }),
    });
    const { store, target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    const first = loader.ensure(loaderTarget);
    const second = loader.ensure(loaderTarget);
    expect(first).toBe(second);
    await first;
    expect(callsFor('listMessagesPage')).toHaveLength(1);
    expect(store.getState().message.s1).toHaveLength(2);
  });

  it('prefetch upgrades to initial without restart', async () => {
    configureHarness({
      listMessagesPage: () => ({ data: entries(2), response: { status: 200 } }),
    });
    const { target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    const inflight = loader.prefetch(loaderTarget);
    const promoted = loader.ensure(loaderTarget, { reason: 'navigation' });
    expect(promoted).toBe(inflight);
    await inflight;
    expect(callsFor('listMessagesPage')).toHaveLength(1); // no second fetch
  });

  it('initial underfill expands when no user message and a cursor exists', async () => {
    const pages = new Map<number, unknown>([
      [50, { data: entries(50, 'assistant'), cursor: 'c1' }],
      [100, { data: userEntries(), cursor: null }],
    ]);
    configureHarness({
      listMessagesPage: (call) => {
        const page = pages.get((call.opts?.limit as number) ?? 50) ?? { data: [] };
        return { ...page, response: { status: 200 } };
      },
    });
    const { store, target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    await loader.ensure(loaderTarget, { force: true });
    expect(callsFor('listMessagesPage').map((call) => call.opts?.limit)).toEqual([50, 100]); // initial(50) then expansion(100) once a user message appears
    expect(store.getState().message.s1!.length).toBe(100); // expanded page committed
    expect(store.getState().message.s1!.every((m) => m.role === 'user')).toBe(true);
  });

  it('refreshTail windows the tail without clobbering the coverage cursor', async () => {
    configureHarness({
      listMessagesPage: () => ({ data: entries(3), response: { status: 200 } }),
      listMessages: () => ({ data: [], response: { status: 200 } }),
    });
    const { store, target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    await loader.ensure(loaderTarget, { force: true });
    const cursorAfterInitial = loader.getState(loaderTarget).cursor;
    await loader.refreshTail(loaderTarget, 5);
    const state = loader.getState(loaderTarget);
    expect(state.cursor).toBe(cursorAfterInitial); // tail refresh does NOT replace coverage cursor
    expect(store.getState().message.s1!.length).toBe(3);
  });

  it('queues a tail refresh behind an in-flight older load (newest authority wins)', async () => {
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    configureHarness({
      listMessagesPage: () => new Promise((resolvePromise) => {
        releaseBox.fn = () => resolvePromise({ data: entries(5), response: { status: 200 } });
      }),
      listMessages: () => ({ data: [], response: { status: 200 } }),
    });
    const { target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    const initial = loader.ensure(loaderTarget, { force: true });
    const tail = loader.refreshTail(loaderTarget, 5);
    releaseBox.fn?.();
    await initial;
    await tail;
    expect(callsFor('listMessagesPage')).toHaveLength(2); // queued refresh ran after the in-flight load
  });

  it('stale generations publish nothing (invalidate bump)', async () => {
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    configureHarness({
      listMessagesPage: () => new Promise((resolvePromise) => { releaseBox.fn = () => resolvePromise({ data: entries(2), response: { status: 200 } }); }),
      listMessages: () => ({ data: [], response: { status: 200 } }),
    });
    const { store, target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    const inflight = loader.ensure(loaderTarget, { force: true });
    loader.invalidateSession(loaderTarget);
    releaseBox.fn?.();
    await inflight;
    expect(store.getState().message.s1).toBeUndefined(); // stale completion published nothing
    expect(loader.getState(loaderTarget).status).not.toBe('ready');
  });

  it('initializeCreatedSession claims an EMPTY transcript and supersedes loads', async () => {
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    configureHarness({
      listMessagesPage: () => new Promise((resolvePromise) => { releaseBox.fn = () => resolvePromise({ data: entries(4), response: { status: 200 } }); }),
      listMessages: () => ({ data: [], response: { status: 200 } }),
    });
    const { store, target: loaderTarget } = target();
    const loader = new SessionMessageLoader();
    const inflight = loader.ensure(loaderTarget, { force: true });
    loader.initializeCreatedSession(loaderTarget);
    releaseBox.fn?.();
    await inflight;
    expect(store.getState().message.s1).toEqual([]); // empty claim held; superseded load discarded
    expect(loader.getState(loaderTarget)).toMatchObject({ status: 'ready', complete: true, resolved: true });
  });
});

function userEntries(): { info: { id: string; sessionID: string; role: string; time: { created: number } }; parts: [] }[] {
  return Array.from({ length: 100 }, (_, index) => ({
    info: { id: `u${index}`, sessionID: 's1', role: 'user', time: { created: index } },
    parts: [],
  }));
}
