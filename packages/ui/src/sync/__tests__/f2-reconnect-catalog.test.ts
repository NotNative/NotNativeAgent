// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => 'f2-test-runtime', onRuntimeEndpointChanged: () => () => undefined,
}));

import { configureHarness, callsFor } from './harness-client-mock.ts';
import { createSyncEngine, type SyncEngine } from '../sync-engine.ts';
import { createDirectoryStore } from '../child-store.ts';
import { useGlobalSessionsStore } from '../global-stores.ts';
import { useSessionViewStore } from '../view-store.ts';
import type { Session } from '../../lib/nnd/types.ts';

const directory = 'D:/work';
const record = (id: string): Session => ({ id, directory, title: id, time: { created: 1, updated: 2 } }) as Session;
let engine: SyncEngine;
beforeEach(() => {
  configureHarness({});
  useGlobalSessionsStore.getState().reset();
  useSessionViewStore.setState({ activeDirectory: directory, currentSessionId: null });
  engine = createSyncEngine();
  const store = createDirectoryStore();
  store.setState({ session: [record('old')], sessionTotal: 1, sessionListSource: 'authoritative', status: 'complete' });
  engine.manager.children.set(directory, store);
  useGlobalSessionsStore.getState().upsertSession(record('old'));
});
afterEach(() => { engine.dispose(); useGlobalSessionsStore.getState().reset(); });

it('refreshes steering capability per candidate without letting a failed read break the resync', async () => {
  useSessionViewStore.getState().setCurrentSession('new'); // makes 'new' a reconnect candidate
  configureHarness({
    listSessions: call => call.opts?.archived ? [record('new')] : call.opts?.roots ? [record('new')] : [],
    getSession: () => record('new'),
    // A failed capability read is a display-hint miss: the resync must stay
    // green and the next poll retries.
    childSteeringCapability: () => ({ error: 'offline' }),
  });
  await engine.resyncAfterStreamGap('stream-reconnect');
  const child = engine.childStoreOf(directory)!.getState();
  expect(child.session.map(session => session.id)).toEqual(['new']);
  const capabilityCalls = callsFor('childSteeringCapability');
  expect(capabilityCalls).toHaveLength(1); // exactly one bounded GET per candidate
  expect(capabilityCalls[0]?.directory).toBe(directory);
});

it('reconciles idle offline creation and deletion after an SSE gap without changing the view', async () => {
  configureHarness({
    listSessions: call => call.opts?.archived ? [record('new')] : call.opts?.roots ? [record('new')] : [],
  });
  await engine.resyncAfterStreamGap('replay-reset');
  const child = engine.childStoreOf(directory)!.getState();
  expect(child.session.map(session => session.id)).toEqual(['new']);
  expect(child.sessionTotal).toBe(1);
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['new']);
  expect(useSessionViewStore.getState()).toMatchObject({ activeDirectory: directory, currentSessionId: null });
  expect(callsFor('listSessions').map(call => call.opts)).toEqual([
    expect.objectContaining({ roots: true, archived: false }),
    expect.objectContaining({ roots: false, archived: false }),
    expect.objectContaining({ archived: true }),
  ]);
});

it('retires an offline-deleted selected session only after a complete inclusive catalog', async () => {
  useSessionViewStore.getState().setCurrentSession('old');
  configureHarness({ listSessions: call => call.opts?.archived ? [record('new')]
    : call.opts?.roots ? [record('new')] : [] });
  await engine.resyncAfterStreamGap('stream-reconnect');
  expect(useSessionViewStore.getState()).toMatchObject({ activeDirectory: directory, currentSessionId: null });
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['new']);
});

it('keeps a selected session that was archived while offline', async () => {
  useSessionViewStore.getState().setCurrentSession('old');
  configureHarness({ listSessions: call => call.opts?.archived ? [{ ...record('old'), time: { created: 1, updated: 2, archived: 3 } }]
    : [] });
  await engine.resyncAfterStreamGap('stream-reconnect');
  expect(useSessionViewStore.getState().currentSessionId).toBe('old');
  expect(useGlobalSessionsStore.getState().archived.map(session => session.id)).toEqual(['old']);
});

it('reads the complete native root and child catalog before removing absent sessions', async () => {
  const roots = Array.from({ length: 501 }, (_, index) => record(`root-${index}`));
  const children = Array.from({ length: 501 }, (_, index) => ({ ...record(`child-${index}`), parentID: 'root-0' }));
  configureHarness({ listSessions: call => {
    if (call.opts?.archived) return [...roots, ...children];
    const list = call.opts?.roots ? roots : children;
    return typeof call.opts?.limit === 'number' ? list.slice(0, call.opts.limit) : list;
  } });
  await engine.resyncAfterStreamGap('stream-reconnect');
  const saved = engine.childStoreOf(directory)!.getState().session;
  expect(saved).toHaveLength(1002);
  expect(saved.some(session => session.id === 'root-500')).toBe(true);
  expect(saved.some(session => session.id === 'child-500')).toBe(true);
  expect(callsFor('listSessions').filter(call => call.opts?.roots !== undefined)
    .every(call => call.opts?.limit === undefined)).toBe(true);
});

it('preserves the last catalog when native list responses are unavailable or malformed', async () => {
  configureHarness({ listSessions: call => call.opts?.archived ? { data: {} } : { data: {} } });
  await engine.resyncAfterStreamGap('stream-reconnect');
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['old']);
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['old']);
  expect(useGlobalSessionsStore.getState().status).toBe('error');
});

it('keeps the prior sidebar snapshot when its inclusive read fails after a child refresh', async () => {
  configureHarness({ listSessions: call => call.opts?.archived ? { error: 'offline' }
    : call.opts?.roots ? [record('new')] : [] });
  await engine.resyncAfterStreamGap('stream-reconnect');
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['new']);
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['old']);
  expect(useGlobalSessionsStore.getState().status).toBe('error');
});

it('does not treat a failed child-page read as proof that cached children were deleted', async () => {
  const store = engine.childStoreOf(directory)!;
  store.setState({ session: [record('old'), { ...record('child'), parentID: 'old' }] });
  configureHarness({ listSessions: call => call.opts?.archived ? [record('new')]
    : call.opts?.roots ? [record('new')] : { data: {} } });
  await engine.resyncAfterStreamGap('stream-reconnect');
  expect(store.getState().session.map(session => session.id)).toEqual(['old', 'child']);
});

it('never copies the one native workspace catalog into a different child store', async () => {
  const other = 'D:/other';
  const foreignStore = createDirectoryStore();
  foreignStore.setState({ session: [{ ...record('foreign'), directory: other }], sessionTotal: 1,
    sessionListSource: 'authoritative', status: 'complete' });
  engine.manager.children.set(other, foreignStore);
  configureHarness({ listSessions: call => call.opts?.archived ? [record('native')]
    : call.opts?.roots ? [record('native')] : [] });
  await engine.resyncAfterStreamGap('replay-reset');
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['native']);
  expect(foreignStore.getState().session.map(session => session.id)).toEqual(['foreign']);
  expect(foreignStore.getState().sessionListSource).toBe('authoritative');
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['native']);
});

it('keeps a newer live creation and deletion over a stale in-flight catalog response', async () => {
  let releaseRoots!: (value: Session[]) => void;
  const roots = new Promise<Session[]>(resolve => { releaseRoots = resolve; });
  configureHarness({
    listSessions: call => call.opts?.archived ? [record('live')] : call.opts?.roots ? roots : [],
  });
  const pending = engine.resyncAfterStreamGap('replay-reset');
  await vi.waitFor(() => expect(callsFor('listSessions')).toHaveLength(1));
  engine.handleHarnessEventDirect({ type: 'session.created', directory, properties: { info: record('live') } });
  engine.handleHarnessEventDirect({ type: 'session.deleted', directory, properties: { sessionID: 'old' } });
  releaseRoots([record('old')]);
  await pending;
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['live']);
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['live']);
});

it('does not let an older bootstrap list overwrite a completed reconnect snapshot', async () => {
  let releaseOld!: (value: Session[]) => void;
  const oldRoots = new Promise<Session[]>(resolve => { releaseOld = resolve; });
  let rootReads = 0;
  configureHarness({
    getConfig: () => ({}), getPath: () => ({}), sessionStatus: () => ({}),
    listSessions: call => call.opts?.archived ? [record('new')]
      : call.opts?.roots ? (++rootReads === 1 ? oldRoots : [record('new')]) : [],
  });
  engine.manager.requestBootstrap({ directory, priority: 0, reason: 'action-demand', force: true });
  await vi.waitFor(() => expect(rootReads).toBe(1));
  await engine.resyncAfterStreamGap('replay-reset');
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['new']);
  releaseOld([record('old')]);
  await vi.waitFor(() => expect(engine.manager.states.get(directory)).toBe('complete'));
  expect(engine.childStoreOf(directory)!.getState().session.map(session => session.id)).toEqual(['new']);
  expect(useGlobalSessionsStore.getState().active.map(session => session.id)).toEqual(['new']);
});
