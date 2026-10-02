// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { DirectoryEventBatch } from '../event-reducer.ts';
import { INITIAL_STATE, type DirectoryStore } from '../types.ts';
import { parseNnaProjection } from '../nna-projection.ts';
import type { Session } from '../../lib/nnd/types.ts';

const frame = (revision = 1, phase: string | null = 'waiting_provider') => ({ version: '1.0', sessionID: 'session-1',
  epoch: 'projection_first', revision, updatedAt: 100 + revision,
  turnState: phase === null ? null : { phase }, activeTools: null, context: null });
function setup() {
  const session: Session = { id: 'session-1', slug: 'session-1', projectID: 'project-1', directory: 'D:/work', version: '1',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, title: 'Build', time: { created: 1, updated: 10 },
    metadata: { nnd: { governance: { reviewPosture: 'auto-review' }, configuredModel: { providerID: 'local', modelID: 'model' } } } };
  const store = createStore<DirectoryStore>(() => ({ ...JSON.parse(JSON.stringify(INITIAL_STATE)), session: [session], patch: () => {}, replace: () => {} }));
  const apply = (value: unknown, sessionID = 'session-1') => {
    const batch = new DirectoryEventBatch(store); batch.apply({ type: 'nnd.projection', properties: { sessionID, frame: value } }, 200);
    return batch.commit();
  };
  return { store, apply };
}
describe('NNA versioned projection frames', () => {
  it('updates authored display fields and preserves governance/model state while empty values clear stale measurements', () => {
    const { store, apply } = setup(); const value = { ...frame(), activeTools: { count: 1, names: ['shell_run'] },
      context: { estimatedTokens: 25, limitTokens: 100, measurement: 'estimated', observedAt: 100 } };
    expect(apply(value)).toBe(1);
    const nnd = store.getState().session[0]!.metadata?.nnd as Record<string, unknown>;
    expect(nnd.governance).toEqual({ reviewPosture: 'auto-review' }); expect(nnd.configuredModel).toEqual({ providerID: 'local', modelID: 'model' });
    expect(nnd.turnState).toEqual({ phase: 'waiting_provider' }); expect(nnd.activeTools).toEqual(value.activeTools);
    expect(apply(frame(2, null))).toBe(1);
    const empty = store.getState().session[0]!.metadata?.nnd as Record<string, unknown>;
    expect(empty).not.toHaveProperty('turnState'); expect(empty).not.toHaveProperty('activeTools'); expect(empty).not.toHaveProperty('context');
  });
  it('ignores duplicate/out-of-order frames without changing any store reference', () => {
    const { store, apply } = setup(); apply(frame(3, 'streaming')); const current = store.getState();
    expect(apply(frame(3))).toBe(0); expect(apply({ ...frame(2), updatedAt: 9999 })).toBe(0);
    expect(store.getState()).toBe(current);
    const batch = new DirectoryEventBatch(store);
    batch.apply({ type: 'session.updated', properties: { info: { ...current.session[0], time: { created: 1, updated: 9999 },
      metadata: { nnd: { projection: frame(2), turnState: { phase: 'waiting_provider' } } } } } }, 200);
    expect(batch.commit()).toBe(0); expect(store.getState()).toBe(current);
  });
  it('rejects malformed identities, authority fields, bounds, and unsupported phases before mutating a session', () => {
    const { store, apply } = setup(); const current = store.getState();
    for (const value of [null, [], { ...frame(), version: '2.0' }, { ...frame(), permission: 'approve' },
      { ...frame(), revision: 0 }, { ...frame(), epoch: 'bad\nepoch' }, frame(1, 'invented'),
      { ...frame(), turnState: { phase: { toString: null } } }, { ...frame(), activeTools: { count: 1, names: [] } },
      { ...frame(), activeTools: { count: 65, names: Array(65).fill('tool') } }, { ...frame(), context: { estimatedTokens: -1 } }]) {
      expect(parseNnaProjection(value)).toBeNull(); expect(apply(value)).toBe(0);
    }
    expect(apply(frame(), 'different-session')).toBe(0); expect(apply({ ...frame(), sessionID: 'missing' }, 'missing')).toBe(0);
    expect(store.getState()).toBe(current);
  });
});
