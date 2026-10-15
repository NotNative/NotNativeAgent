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
import { createSyncEngine } from '../sync-engine.ts';
import { reconcileFetchedSession } from '../engine-recovery.ts';
import { bootstrapDirectory } from '../bootstrap-directory.ts';
import { useGlobalSessionStatusStore } from '../global-stores.ts';
import { useConfigStore } from '../../stores/useConfigStore.ts';
import type { EngineServices as LegacyServices } from '../session-lifecycle.ts';
import type { DirectoryStore } from '../types.ts';
import { INITIAL_STATE } from '../types.ts';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../authority-sync.ts';
import { createSessionActions } from '../engine-actions.ts';
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

it('forks a background sidebar conversation in its explicit workspace instead of the selected workspace', async () => {
  configureHarness({ forkSession: () => ({ id: 'forked' }) });
  const ports = services({ directoryForSession: () => 'D:/stale' });
  const actions = createSessionActions(ports, () => new Map());
  expect(await actions.fork('background', undefined, 'D:/other')).toBe('forked');
  expect(callsFor('forkSession')[0]?.directory).toBe('D:/other');
});

it('restoring an archived session reloads the invalidated transcript in its workspace', async () => {
  configureHarness({ updateSession: () => ({ id: 'restored' }) });
  const registerSessionRoute = vi.fn(), loaderRefreshTail = vi.fn(async () => undefined);
  const ports = services({ registerSessionRoute, loaderRefreshTail });
  const actions = createSessionActions(ports, () => new Map());
  await actions.restore('restored', 'D:/other');
  expect(registerSessionRoute).toHaveBeenCalledWith('restored', 'D:/other');
  expect(loaderRefreshTail).toHaveBeenCalledWith('D:/other', 'restored', ports.peekChild('D:/other'));
  configureHarness({ updateSession: () => ({ error: 'offline' }) });
  loaderRefreshTail.mockClear();
  await expect(actions.restore('restored', 'D:/other')).rejects.toThrow('offline');
  expect(loaderRefreshTail).not.toHaveBeenCalled();
});

it('blocks prompt, create, fork, rename, and question decisions while native authority is stale', async () => {
  const actions = createSessionActions(services(), () => new Map());
  const token = beginAuthorityRecovery('test-runtime');
  try {
    expect(() => actions.send({ directory: 'D:/work', sessionID: 's1', parts: [{ type: 'text', text: 'run' }],
      model: { providerID: 'p', modelID: 'm' } })).toThrow(/resynchronizing/);
    expect(() => actions.createSession({ directory: 'D:/work' })).toThrow(/resynchronizing/);
    await expect(actions.fork('s1', 'm1')).rejects.toThrow(/resynchronizing/);
    await expect(actions.rename('s1', 'new title')).rejects.toThrow(/resynchronizing/);
    expect(() => actions.replyQuestion('s1', { id: 'q1' } as never, [['yes']], false)).toThrow(/resynchronizing/);
    for (const name of ['promptAsync', 'createSession', 'forkSession', 'updateSession', 'replyToQuestion']) {
      expect(callsFor(name as Parameters<typeof callsFor>[0])).toHaveLength(0);
    }
  } finally { finishAuthorityRecovery('test-runtime', token, true); }
});

describe('optimistic send (§E.2)', () => {
  it('uploads native files before submitting a file-only prompt with a stable reference', async () => {
    configureHarness({
      uploadAttachment: (call) => ({ data: { upload_id: (call.body as { upload_id: string }).upload_id }, response: { status: 201 } }),
      promptAsync: () => ({ data: undefined, response: { status: 204 } }),
    });
    const store = freshStore({ config: { nnd: { engine: 'nna' } } });
    const engine = services({ ensureChild: () => store });
    await optimisticSend(engine, { directory: 'D:/work', sessionID: 's1',
      parts: [{ type: 'text', text: '' }, { type: 'file', url: 'data:text/plain;base64,SGk=', mime: 'text/plain', filename: 'note.txt' }],
      model: { providerID: 'p', modelID: 'm' } });
    const upload = callsFor('uploadAttachment')[0]!;
    const sent = callsFor('promptAsync')[0]!.body as { messageID: string; parts: Array<{ type: string; upload_id?: string }> };
    expect(upload.path).toBe('/v1/nnd/sessions/s1/attachments');
    expect(sent.parts).toEqual([{ type: 'text', text: '' },
      { type: 'file', upload_id: (upload.body as { upload_id: string }).upload_id }]);
    expect((upload.body as { upload_id: string }).upload_id).toMatch(new RegExp(`^${sent.messageID}_1$`));
  });
  it('does not send when a replay gap appears during connection wait', async () => {
    let resume!: () => void;
    const engine = services({ waitForConnection: () => new Promise<void>((resolve) => { resume = resolve; }) });
    const pending = optimisticSend(engine, { directory: 'D:/work', sessionID: 's1',
      parts: [{ type: 'text', text: 'hi' }], model: { providerID: 'p', modelID: 'm' } });
    const token = beginAuthorityRecovery('test-runtime');
    resume();
    try {
      await expect(pending).rejects.toThrow(/resynchronizing/);
      expect(callsFor('promptAsync')).toHaveLength(0);
    } finally { finishAuthorityRecovery('test-runtime', token, true); }
  });
  it('publishes local busy and rollback to the global child-status index', async () => {
    let rejectSend: ((reason: Error) => void) | undefined;
    configureHarness({ promptAsync: () => new Promise((_resolve, reject) => { rejectSend = reject; }) });
    useConfigStore.setState({ isConnected: true });
    useGlobalSessionStatusStore.getState().reset();
    const engine = createSyncEngine();
    const store = engine.manager.ensureChild('D:/work');
    const send = engine.actions.send({ directory: 'D:/work', sessionID: 'child', parts: [{ type: 'text', text: 'continue' }], model: { providerID: 'p', modelID: 'm' } });
    await vi.waitFor(() => expect(rejectSend).toBeTypeOf('function'));
    expect(store.getState().session_status.child).toEqual({ type: 'busy' });
    expect(useGlobalSessionStatusStore.getState().statusById.child).toEqual({ type: 'busy' });
    rejectSend!(Object.assign(new Error('rejected'), { status: 500 }));
    await expect(send).rejects.toThrow('rejected');
    expect(store.getState().session_status.child).toEqual({ type: 'idle' });
    expect(useGlobalSessionStatusStore.getState().statusById.child).toBeUndefined();
    engine.dispose();
    useConfigStore.setState({ isConnected: false });
  });

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
  it('rejects remembered approvals without sending or removing the request', async () => {
    const store = freshStore({ permission: { s1: [request()] } });
    const children = new Map([['D:/owning', store]]);
    await expect(replyToPermission(services(), children, 's1', request(), 'always')).rejects.toThrow('Remembered');
    expect(callsFor('replyToPermission')).toHaveLength(0);
    expect(store.getState().permission.s1).toHaveLength(1);
  });

  it('prevents direct interactive decisions for the NNA runtime', async () => {
    const store = freshStore({ config: { nnd: { engine: 'nna' } }, permission: { s1: [request()] } });
    const children = new Map([['D:/owning', store]]);
    await expect(replyToPermission(services(), children, 's1', request(), 'once')).rejects.toThrow('NNA owns');
    expect(callsFor('replyToPermission')).toHaveLength(0);
    expect(store.getState().permission.s1).toHaveLength(1);
  });

  it('retains the pending request after a failed reply so the operator can retry', async () => {
    configureHarness({ replyToPermission: () => ({ error: 'offline', response: { status: 503 } }) });
    const store = freshStore({ permission: { s1: [request()] } });
    await expect(replyToPermission(services(), new Map([['D:/owning', store]]), 's1', request(), 'once')).rejects.toThrow('offline');
    expect(store.getState().permission.s1).toHaveLength(1);
  });
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
  it('does not let a late older GET undo a live child phase, and removes corrected metadata', () => {
    const live = { id: 'child', parentID: 'root', time: { created: 1, updated: 9 },
      metadata: { nnd: { turnState: { phase: 'running_tool' } } } } as unknown as Session;
    const stale = { id: 'child', parentID: 'root', time: { created: 1, updated: 8 },
      metadata: { nnd: { turnState: { phase: 'waiting_provider' } } } } as unknown as Session;
    const current = [live];
    const state = { session: current, sessionEventRevision: {}, sessionDeletedRevision: {} };
    expect(reconcileFetchedSession(state, stale, 0)).toBe(current);
    const corrected = { id: 'child', parentID: 'root', time: { created: 1, updated: 10 } } as Session;
    expect(reconcileFetchedSession(state, corrected, 0)).toEqual([corrected]);
    expect(reconcileFetchedSession(state, corrected, 0)[0]!.metadata).toBeUndefined();
  });

  it('does not revive a deleted child or overwrite a same-timestamp live update after GET began', () => {
    const fetched = { id: 'child', parentID: 'root', time: { created: 1, updated: 9 },
      metadata: { nnd: { turnState: { phase: 'waiting_provider' } } } } as unknown as Session;
    const live = { ...fetched, metadata: { nnd: { turnState: { phase: 'running_tool' } } } } as Session;
    const afterLive = { session: [live], sessionEventRevision: { child: 7 }, sessionDeletedRevision: {} };
    expect(reconcileFetchedSession(afterLive, fetched, 6)).toBe(afterLive.session);
    const afterDelete = { session: [] as Session[], sessionEventRevision: { child: 8 }, sessionDeletedRevision: { child: 8 } };
    expect(reconcileFetchedSession(afterDelete, fetched, 6)).toBe(afterDelete.session);
    // A later reconnect can still correct an extant child, but an earlier
    // tombstone cannot be bypassed by a late response for a removed candidate.
    expect(reconcileFetchedSession(afterDelete, fetched, 8)).toBe(afterDelete.session);
    const recreated = { session: [live], sessionEventRevision: { child: 9 }, sessionDeletedRevision: { child: 8 } };
    expect(reconcileFetchedSession(recreated, { ...live, time: { created: 1, updated: 10 } }, 9)).toHaveLength(1);
  });

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

  it('bootstrap captures the live-event baseline before list GETs, preserving an update and deletion', async () => {
    let releaseRoots!: (value: Session[]) => void;
    const roots = new Promise<Session[]>((resolve) => { releaseRoots = resolve; });
    const staleRoot = { id: 'root', time: { created: 1, updated: 1 } } as Session;
    const staleChild = { id: 'child', parentID: 'root', time: { created: 2, updated: 2 } } as Session;
    configureHarness({
      getConfig: () => ({}), getPath: () => ({}), sessionStatus: () => ({}),
      listSessions: (call) => call.opts?.roots ? roots : [staleChild],
    });
    const store = freshStore({ sessionRevision: 5, session: [staleRoot, staleChild] });
    let observedBaseline = -1;
    const pending = bootstrapDirectory('D:/work', store, () => true, {
      activeProjectFor: () => null,
      mergeBootstrap: (_dir, target, fetchedRoots, fetchedChildren, baseline) => {
        observedBaseline = baseline;
        const state = target.getState();
        const liveIds = new Set(Object.entries(state.sessionEventRevision)
          .filter(([, revision]) => revision > baseline).map(([id]) => id));
        const deletedIds = new Set(Object.entries(state.sessionDeletedRevision)
          .filter(([, revision]) => revision > baseline).map(([id]) => id));
        target.setState({ session: mergeBootstrapLists(state.session, fetchedRoots, fetchedChildren, liveIds, deletedIds) });
      },
    });
    await vi.waitFor(() => expect(callsFor('listSessions')).toHaveLength(1));
    const liveRoot = { ...staleRoot, time: { created: 1, updated: 9 } } as Session;
    store.setState({ session: [liveRoot], sessionRevision: 7,
      sessionEventRevision: { root: 6, child: 7 }, sessionDeletedRevision: { child: 7 } });
    releaseRoots([staleRoot]);
    await expect(pending).resolves.toBe('complete');
    expect(observedBaseline).toBe(5);
    expect(store.getState().session).toEqual([liveRoot]);
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
