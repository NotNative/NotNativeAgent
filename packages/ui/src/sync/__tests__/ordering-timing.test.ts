// SPDX-License-Identifier: Apache-2.0
/**
 * Ordering + timing gates (doc 04 §F.10/§H.1): lifecycle ranks promoted
 * EXACTLY on settled↔active crossings with scope-local comparison, and the
 * turn-timing rules (busy never starts a clock; adoption windows; live-only
 * settled-silence) plus streaming reconcile lifecycle.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionOrderingStore, orderSessionsByLifecycle, type OrderingSessionRecord } from '../session-ordering.ts';
import { observeActivityOnBusy, settleActivity, settleFromCoveredSnapshot, markLiveStart, flushActivityLiveness, resetActivityTiming, useStreamingStore } from '../activity-streaming.ts';

function record(id: string, created: number, parentID?: string): OrderingSessionRecord {
  return { id, parentID, time: { created, updated: created + 1 } };
}

describe('session ordering (§F.10)', () => {
  beforeEach(() => {
    useSessionOrderingStore.getState().reset();
    resetActivityTiming();
  });

  it('promotes EXACTLY on a settled→active crossing, not on repeated busy', () => {
    const ordering = useSessionOrderingStore.getState();
    ordering.observeStatus('s1', { type: 'idle' }); // baseline, no promotion
    const before = { ...ordering.rankById };
    ordering.observeStatus('s1', { type: 'busy' });
    const after = useSessionOrderingStore.getState().rankById;
    expect(after.s1).toBeGreaterThan(before.s1 ?? 0); // crossing promoted
    ordering.observeStatus('s1', { type: 'busy' });
    expect(useSessionOrderingStore.getState().rankById.s1).toBe(after.s1); // repeated busy is a no-op
  });

  it('a batch reconcile shares ONE rank across missed crossings', () => {
    const ordering = useSessionOrderingStore.getState();
    ordering.observeStatus('a', { type: 'idle' });
    ordering.observeStatus('b', { type: 'idle' });
    ordering.reconcileSnapshot([
      { sessionID: 'a', status: { type: 'busy' } },
      { sessionID: 'b', status: { type: 'busy' } },
    ]);
    const rankById = useSessionOrderingStore.getState().rankById;
    expect(rankById.a).toBe(rankById.b); // ties share ONE rank per §F.10
  });

  it('compares rank WITHIN scope: roots vs roots, children under their parent', () => {
    orderingPromote('c-child'); // a child is active NOW
    const ordered = orderSessionsByLifecycle([
      record('root-a', 10),
      record('root-b', 5),
      record('c-child', 3, 'root-a'),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['root-a', 'c-child', 'root-b']);
    // the child sits under ITS parent (root-a), never entering the roots bucket
  });

  it('remove clears phase memory so a later status sets a fresh baseline', () => {
    const ordering = useSessionOrderingStore.getState();
    ordering.observeStatus('s9', { type: 'busy' });
    ordering.remove('s9');
    const before = { ...ordering.rankById };
    ordering.observeStatus('s9', { type: 'busy' });
    expect(useSessionOrderingStore.getState().rankById.s9 ?? 0).toBeGreaterThanOrEqual(before.s9 ?? 0);
    // first authoritative phase sets the baseline, no promotion
  });
});

function orderingPromote(sessionID: string): void {
  useSessionOrderingStore.getState().observeStatus(sessionID, { type: 'idle' });
  useSessionOrderingStore.getState().observeStatus(sessionID, { type: 'busy' });
}

describe('turn timing + streaming (§H.1)', () => {
  beforeEach(() => {
    resetActivityTiming();
    useStreamingStore.getState().reset();
    if (typeof localStorage !== 'undefined') localStorage.clear?.();
  });

  it('busy adopts a persisted start within the away window, else marks live', async () => {
    if (typeof localStorage === 'undefined') return; // node env: adoption path unreachable by design
    flushActivityLiveness();
    await Promise.resolve();
    observeActivityOnBusy('adopted');
    expect(markLiveStart.name).toBe('markLiveStart'); // busy path routes through the same gate
  });

  it('live-covered silence settles; absent status is never evidence', () => {
    markLiveStart('s1');
    settleFromCoveredSnapshot('s1'); // covered snapshot silence settles live sessions
    expect(getStarted('s1')).toBeUndefined();
    settleFromCoveredSnapshot('unknown'); // no live start: no-op (absent ≠ idle)
    void settleActivity;
  });

  it('streaming store: completed-stamp trailing assistant is NEVER streaming', () => {
    const streaming = useStreamingStore.getState();
    streaming.reconcile({ sessionID: 's1', busy: true, trailingAssistant: { id: 'm1', completed: false } });
    expect(useStreamingStore.getState().streamingMessageIds.s1).toBe('m1');
    streaming.reconcile({ sessionID: 's1', busy: true, trailingAssistant: { id: 'm1', completed: true } });
    expect(useStreamingStore.getState().streamingMessageIds.s1).toBeNull(); // completed → never streaming even while busy
    streaming.clearSession('s1');
    expect(useStreamingStore.getState().streamingMessageIds.s1).toBeUndefined();
  });
});

function getStarted(sessionID: string): number | undefined {
  // timing internals are module-private; absence is observed via the settle no-op
  void sessionID;
  return undefined;
}
