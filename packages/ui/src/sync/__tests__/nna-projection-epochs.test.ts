// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => 'test-runtime', onRuntimeEndpointChanged: () => () => undefined }));
import { DirectoryEventBatch } from '../event-reducer.ts';
import { INITIAL_STATE, type DirectoryStore } from '../types.ts';
import { applyNnaProjection, sessionProjection, staleProjection, type NnaProjection } from '../nna-projection.ts';
import { reconcileFetchedSession } from '../engine-recovery.ts';
import { mergeBootstrapLists } from '../session-actions.ts';
import type { Session } from '../../lib/nnd/types.ts';

function frame(epoch: string, revision = 1, updatedAt = 100, phase = 'idle'): NnaProjection {
  return { version: '1.0', sessionID: 'session-1', epoch, revision, updatedAt,
    turnState: { phase }, activeTools: null, context: null };
}
function session(value: NnaProjection): Session {
  return { id: value.sessionID, slug: value.sessionID, projectID: 'project-1', directory: 'D:/work', title: 'Build', version: '1',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: value.updatedAt },
    metadata: { nnd: { projection: value, turnState: value.turnState } } };
}
const oldSession = () => session(frame('before_restart', 10, 1000, 'running_tool'));

describe('projection epoch recovery', () => {
  it('accepts restored older timestamps, then ignores late retired live frames and descriptions', () => {
    const store = createStore<DirectoryStore>(() => ({ ...JSON.parse(JSON.stringify(INITIAL_STATE)),
      session: [oldSession()], patch: () => {}, replace: () => {} }));
    const apply = (type: string, properties: Record<string, unknown>) => {
      const batch = new DirectoryEventBatch(store); batch.apply({ type, properties }, 200); return batch.commit();
    };
    expect(apply('session.updated', { info: session(frame('after_restart')) })).toBe(1);
    expect(sessionProjection(store.getState().session[0])?.epoch).toBe('after_restart');
    expect(apply('nnd.projection', { sessionID: 'session-1', frame: frame('after_restart', 2, 101, 'preparing') })).toBe(1);
    const current = store.getState();
    expect(apply('nnd.projection', { sessionID: 'session-1', frame: frame('before_restart', 999, 9999) })).toBe(0);
    expect(apply('session.updated', { info: session(frame('before_restart', 1000, 10000)) })).toBe(0);
    expect(store.getState()).toBe(current);
  });
  it('carries retired epochs through authoritative refetches and bootstrap replacement', () => {
    const state = { session: [oldSession()], sessionEventRevision: {}, sessionDeletedRevision: {} };
    const fetched = reconcileFetchedSession(state, session(frame('after_restart')), 0);
    expect(sessionProjection(fetched[0])?.epoch).toBe('after_restart');
    expect(reconcileFetchedSession({ ...state, session: fetched }, session(frame('before_restart', 99, 9999)), 0)).toBe(fetched);
    const bootstrapped = mergeBootstrapLists(fetched, [session(frame('after_restart', 2, 101))], [], new Set());
    expect(mergeBootstrapLists(bootstrapped, [session(frame('before_restart', 99, 9999))], [], new Set())[0]).toBe(bootstrapped[0]);
    const directBootstrap = mergeBootstrapLists([oldSession()], [session(frame('new_bootstrap'))], [], new Set());
    expect(sessionProjection(directBootstrap[0])?.epoch).toBe('new_bootstrap');
    expect(mergeBootstrapLists(directBootstrap, [oldSession()], [], new Set())[0]).toBe(directBootstrap[0]);
  });
  it('accepts a direct restart frame and retains recent retirement through same-epoch revisions', () => {
    let current = oldSession();
    // Bounded in-memory history covers the most recent 32 transitions. Older
    // stream attempts are invalidated by transport generation, not this cache.
    const retired: NnaProjection[] = [];
    for (let index = 0; index < 32; index += 1) {
      retired.push(sessionProjection(current)!);
      current = applyNnaProjection(current, frame(`restart_${index}`, 1, 50));
      current = applyNnaProjection(current, frame(`restart_${index}`, 2, 51));
    }
    expect(sessionProjection(current)?.turnState).toEqual({ phase: 'idle' });
    for (const previous of retired) expect(staleProjection(sessionProjection(current), { ...previous, revision: 999, updatedAt: 9999 })).toBe(true);
  });
  it('restores full metadata after the restart delta arrives before its snapshot', () => {
    const restoredFrame = frame('delta_first', 1, 100);
    const deltaApplied = applyNnaProjection(oldSession(), restoredFrame);
    const snapshot = { ...session({ ...restoredFrame }), title: 'Restored title' };
    const state = { session: [deltaApplied], sessionEventRevision: {}, sessionDeletedRevision: {} };
    const fetched = reconcileFetchedSession(state, snapshot, 0);
    expect(fetched[0]?.title).toBe('Restored title');
    expect(staleProjection(sessionProjection(fetched[0]), frame('before_restart', 999, 9999))).toBe(true);
    const newerMetadata = { ...fetched[0]!, title: 'Newer title', time: { created: 1, updated: 200 } };
    const newerState = { ...state, session: [newerMetadata] };
    expect(reconcileFetchedSession(newerState, snapshot, 0)).toBe(newerState.session);
  });
});
