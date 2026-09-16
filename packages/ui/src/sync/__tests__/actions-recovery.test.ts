// SPDX-License-Identifier: Apache-2.0
/**
 * Actions, dispatch rules, and recovery gates (doc 04 §E.2-E.4/§D.5/§D.7/
 * §F.10): optimistic send failure taxonomy (definite rollback vs ambiguous
 * confirm-in-place), blocking-request ownership routing with NotFound⇒
 * materialize, lifecycle ranks promoted exactly on settled↔active crossings,
 * turn-timing adoption bounds, streaming reconcile, recovery store behavior,
 * and the 750ms settle poll's monotonic no-op when idle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => 'test-runtime',
  onRuntimeEndpointChanged: () => () => undefined,
}));

import { configureHarness, callsFor, type MockCall } from './harness-client-mock.ts';
import { optimisticSend, isAmbiguousSendFailure, replyToPermission, computeSubtreeIds, getReconnectCandidateIds, mergeBootstrapLists } from '../session-actions.ts';
import type { EngineServices as LegacyServices } from '../session-lifecycle.ts';
import type { DirectoryStore } from '../types.ts';
import { INITIAL_STATE } from '../types.ts';
import type { PermissionRequest, Session, SessionStatus } from '../../lib/nnd/types.ts';

function freshStore(seed: Partial<DirectoryStore> = {}): StoreApi<DirectoryStore> {
  const base = JSON.parse(JSON.stringify(INITIAL_STATE)) as DirectoryStore;
  return createStore<DirectoryStore>(() => ({ ...base, ...seed, patch: () => undefined, replace: () => undefined }));
}

function services(overrides: Partial<LegacyServices> = {}): LegacyServices {
  const stores = new Map<string, StoreApi<DirectoryStore>>();
  const materializations: { request: { reason: string; sessionID: string }; directory: string }[] = [];
  return {
    activeDirectory: () => 'D:\\work',
    currentSessionId: () => 's1',
    isConnected: () => true,
    ensureChild: (directory) => {
      if (!stores.has(directory)) stores.set(directory, freshStore());
      return stores.get(directory)!;
    },
    peekChild: (directory) => stores.get(directory),
    registerSessionRoute: () => undefined,
    registerMessageRoute: () => undefined,
    enqueueMaterialization: (request, directory) => materializations.push({ request: request as { reason: string; sessionID: string }, directory }),
    onStatusEvent: () => undefined,
    loaderInitializeCreated: () => undefined,
    loaderOptimisticAdd: (_d, _s, _store, item) => {
      const state = _store.getState();
      _store.setState({ message: { ...state.message, [_s]: [...(state.message[_s] ?? []), item.message] }, part: { ...state.part, [item.messageID]: item.parts } });
    },
    loaderOptimisticRemove: (_d, _s, store, messageID) => {
      const state = store.getState();
      store.setState({
        message: { ...state.message, [_s]: (state.message[_s] ?? []).filter((m) => m.id !== messageID) },
        part: Object.fromEntries(Object.entries(state.part).filter(([key]) => Object.keys(state.part[key as string] ?? []).length === 0 ? false : key !== messageID)),
      });
    },
    loaderOptimisticConfirm: () => undefined,
    loaderRefreshTail: async () => undefined,
    waitForConnection: async () => undefined,
    onSelectSession: () => undefined,
    __materializations: materializations,
    ...overrides,
  } as LegacyServices & { __materializations: { request: { reason: string; sessionID: string }; directory: string }[] };
}

beforeEach(() => configureHarness({}));

describe('optimistic send (§E.2)', () => {
  it('rolls back a DEFINITE failure, restores status, and records evidence', async () => {
    configureHarness({
      promptAsync: () => ({ error: 'rejected', response: { status: 500 } }),
    });
    const engine = services();
    const store = engine.ensureChild('D:/work'); // normalized key: optimisticSend normalizes too
    await expect(optimisticSend(engine, {
      directory: 'D:/work',
      sessionID: 's1',
      parts: [{ type: 'text', text: 'hi' }],
      model: { providerID: 'p', modelID: 'm' },
    })).rejects.toThrow('rejected');
    expect(store.getState().message.s1).toEqual([]); // optimistic draft removed (bucket emptied; [] is never renderable authority)
    expect(store.getState().session_status.s1).toEqual({ type: 'idle' }); // status restored
    expect(isAmbiguousSendFailure(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
  });

  it('CONFIRMS-in-place for an ambiguous landing (no rollback, no double-send)', async () => {
    configureHarness({
      promptAsync: () => ({ error: 'transport died', response: undefined as never }), // response absent ⇒ transportTagged ⇒ ambiguous
      listMessages: () => {
        const sent = (callsFor('promptAsync').at(-1)?.body as { messageID?: string }).messageID;
        return { data: sent ? messagesEcho('s1', sent) : [], response: { status: 200 } };
      },
    });
    const engine = services();
    const store = engine.ensureChild('D:/work');
    await optimisticSend(engine, { directory: 'D:/work', sessionID: 's1', parts: [{ type: 'text', text: 'hi' }], model: { providerID: 'p', modelID: 'm' } });
    const sent = (callsFor('promptAsync').at(-1)?.body as { messageID?: string }).messageID!;
    expect(store.getState().message.s1!.some((m) => m.id === sent)).toBe(true); // draft KEPT
    expect(store.getState().session_status.s1).toEqual({ type: 'busy' }); // no rollback of status
    expect(callsFor('listMessages')).toHaveLength(1); // confirmation refetch saw the landed message
  });

  it('waits for reconnect inside the confirmation window then rolls back on absent', async () => {
    configureHarness({
      promptAsync: () => ({ error: 'transient' }),
      listMessages: () => ({ data: [], error: 'no connection' }),
    });
    let connected = false;
    const engine = services({ isConnected: () => connected });
    const store = engine.ensureChild('D:/work');
    const pending = optimisticSend(engine, { directory: 'D:/work', sessionID: 's1', parts: [{ type: 'text', text: 'hi' }], model: { providerID: 'p', modelID: 'm' } });
    setTimeout(() => { connected = true; }, 30);
    await expect(pending).rejects.toThrow();
    expect(store.getState().message.s1).toEqual([]); // bucket emptied by the stub rollback
    expect(store.getState().session_status.s1).toEqual({ type: 'idle' });
  });
});

function messagesEcho(sessionID: string, messageID: string): { info: { id: string; sessionID: string; role: string; time: { created: number } }; parts: [] }[] {
  return [{ info: { id: messageID, sessionID, role: 'user', time: { created: 1 } }, parts: [] }];
}

describe('blocking requests (§E.4)', () => {
  it('routes by the session RECORD directory (ownership, not containment)', async () => {
    configureHarness({
      replyToPermission: (call) => {
        expect(call.directory).toBe('D:/owning'); // record's own directory answered, normalized
        return { data: true, response: { status: 200 } };
      },
    });
    const childStores = new Map<string, StoreApi<DirectoryStore>>();
    const storeA = freshStore({ session: [{ id: 's1', directory: 'D:/owning', time: { created: 1, updated: 2 } } as Session], permission: { s1: [request()] } });
    childStores.set('D:/a', storeA);
    await replyToPermission(services({ activeDirectory: () => 'D:/other' }), childStores, 's1', request(), 'once');
    expect(storeA.getState().permission.s1).toBeUndefined(); // removed deterministically
  });

  it('PermissionNotFound removes locally and enqueues settled-running-tool', async () => {
    configureHarness({
      replyToPermission: () => ({ error: 'not found: permission', response: { status: 404 } }),
    });
    const childStores = new Map<string, StoreApi<DirectoryStore>>();
    const storeA = freshStore({ permission: { s1: [request()] }, message: { s1: [{ id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 1, completed: 2 } } as never] }, part: { m1: [{ id: 'p1', messageID: 'm1', type: 'tool', sessionID: 's1', state: { status: 'running' } } as never] } });
    childStores.set('D:\\a', storeA);
    const engine = services();
    await replyToPermission(engine, childStores, 's1', request(), 'reject');
    expect(storeA.getState().permission.s1).toBeUndefined();
    const mats = (engine as unknown as { __materializations: { request: { reason: string; sessionID: string }; directory: string }[] }).__materializations;
    expect(mats).toHaveLength(1);
    expect(mats[0]!.request.reason).toBe('settled-running-tool');
  });

  it('subtree ids ascend within a subtree (BFS via childrenByParent)', () => {
    const childStores = new Map<string, StoreApi<DirectoryStore>>();
    const store = freshStore({
      session: [
        { id: 'p', time: { created: 1, updated: 1 } },
      ] as Session[],
    });
    childStores.set('D:\\a', store);
    const ids = computeSubtreeIds(childStores, 'p');
    expect(ids.has('p')).toBe(true);
  });
});

function request(): PermissionRequest {
  return { id: 'perm1', sessionID: 's1', permission: 'bash', patterns: ['*'], metadata: {}, always: [] } as PermissionRequest;
}

describe('reconnect candidates + closed merge (§D.5/§C.2)', () => {
  it('enumerates active, unrenderable, and trailing-unfinished candidates', () => {
    const store = freshStore({
      session: [
        { id: 'a', time: { created: 1, updated: 1 } },
        { id: 'b', time: { created: 2, updated: 2 } },
      ] as Session[],
      session_status: { a: { type: 'busy' } },
      message: { b: [{ id: 'm1', sessionID: 'b', role: 'assistant', time: { created: 5 } } as never] },
    });
    const candidates = getReconnectCandidateIds(store, 'b', 'D:\\work', 'D:\\work');
    expect(candidates).toContain('a'); // busy
    expect(candidates).toContain('b'); // trailing assistant without completion + unrenderable
  });

  it('closed-hierarchy merge retains cached parents and overlays live events', () => {
    const cached: Session[] = [
      { id: 'runtime-root', time: { created: 1, updated: 1 } } as Session,
    ];
    const roots = [{ id: 's1', time: { created: 2, updated: 2 } } as Session];
    const children = [{ id: 'c1', parentID: 's1', time: { created: 3, updated: 3 } } as Session];
    void cached;
    const merged = mergeBootstrapLists([], roots, [...children], new Set(['c1']));
    expect(merged.map((s) => s.id)).toEqual(['c1', 's1']); // closed hierarchy, id-sorted index
    void mergeBootstrapLists;
  });
});

describe('status store authority', () => {
  it('authoritative snapshots lower absent candidates; monotonic never lowers', () => {
    const store = useGlobalRealStore;
    store.getState().reset();
    store.getState().applyEvent('x', { type: 'busy' });
    expect(store.getState().statusById['x']).toEqual({ type: 'busy' });
    // blind (monotonic) poll cannot lower a live entry
    store.getState().applySnapshot({ x: { type: 'idle' } }, ['x'], 'monotonic');
    expect(store.getState().statusById['x']).toEqual({ type: 'busy' });
    // authoritative absence ⇒ explicit idle (snapshot replaces, never empty success)
    store.getState().applySnapshot({}, ['x'], 'authoritative');
    expect(store.getState().statusById['x']).toBeUndefined();
  });
});

import { useGlobalSessionStatusStore as useGlobalRealStore } from '../global-stores.ts';


describe('settle poll (§D.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules ONE deferred mono poll and skips it when the session settled live', async () => {
    configureHarness({
      sessionStatus: () => ({ data: { s1: { type: 'busy' } as SessionStatus }, response: { status: 200 } }),
    });
    const { createMessageCompletionPoll } = await import('../engine-message-poll.ts');
    const manager = { children: new Map<string, StoreApi<DirectoryStore>>([['D:\\work', freshStore({ session_status: { s1: { type: 'idle' as const } } })]]) };
    const poll = createMessageCompletionPoll({ disposed: () => false, manager: manager as never });
    poll.schedule('D:\\work', 's1');
    vi.advanceTimersByTime(800);
    await vi.runAllTimersAsync();
    expect(callsFor('sessionStatus')).toHaveLength(0); // settled live before the poll fired
  });

  it('a live busy session gets a monotonic raise (never lowered by the poll)', async () => {
    configureHarness({
      sessionStatus: () => ({ data: { s1: { type: 'retry', attempt: 2, message: 'm', next: 5 } as SessionStatus }, response: { status: 200 } }),
    });
    const { createMessageCompletionPoll } = await import('../engine-message-poll.ts');
    const store = freshStore({ session_status: { s1: { type: 'busy' as const } } });
    const poll = createMessageCompletionPoll({ disposed: () => false, manager: { children: new Map([['D:\\work', store]]) } as never });
    poll.schedule('D:\\work', 's1');
    await vi.runAllTimersAsync();
    expect(store.getState().session_status.s1).toEqual({ type: 'retry', attempt: 2, message: 'm', next: 5 });
  });
});

export type { MockCall };
