// SPDX-License-Identifier: Apache-2.0
/**
 * Routing (doc 04 §D.3) + guard helpers (§B.2/§D.4): directory-less event
 * resolution precedence and the ordering/equality primitives.
 */
import { describe, expect, it } from 'vitest';
import { createRoutingIndex, registerSessionDirectory, registerMessageSession, dropSession, resolveDirectoryFromRoutingIndex, type EventRoutingIndex } from '../routing-index.ts';
import {
  appendNonOverlappingDelta,
  areSessionStatusesEqual,
  binarySearchIndex,
  getUpdatedDeltaFields,
  shouldPreserveExistingPart,
  shouldSkipStaleSessionEvent,
  upsertById,
  removeById,
} from '../event-equality.ts';
import type { Session } from '../../lib/nnd/types.ts';

function ctx(overrides: Partial<Parameters<typeof resolveDirectoryFromRoutingIndex>[1]> = {}): Parameters<typeof resolveDirectoryFromRoutingIndex>[1] {
  return {
    rawDirectory: '',
    storeHasSession: () => false,
    storeHasMessageParts: () => false,
    findSessionStore: () => null,
    findPartStore: () => null,
    activeDirectory: 'D:/active',
    activeSessionID: null,
    activeStoreExists: false,
    singleStore: null,
    ...overrides,
  };
}

describe('routing resolution precedence', () => {
  it('prefers an explicit directory whose store holds the session (and heals the index)', () => {
    const index = createRoutingIndex();
    const resolved = resolveDirectoryFromRoutingIndex(index, ctx({
      rawDirectory: 'D:/work',
      sessionID: 's1',
      storeHasSession: (dir) => dir === 'D:/work',
    }));
    expect(resolved).toBe('D:/work');
    expect(index.sessionDirectoryById.get('s1')).toBe('D:/work');
  });

  it('uses the indexed directory when its store still exists, else scans', () => {
    const index = createRoutingIndex();
    registerSessionDirectory(index, 's1', 'D:/indexed');
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      sessionID: 's1',
      storeHasSession: (dir) => dir === 'D:/indexed',
    }))).toBe('D:/indexed');
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      sessionID: 's1',
      findSessionStore: (id) => (id === 's1' ? 'D:/scanned' : null),
    }))).toBe('D:/scanned');
    expect(index.sessionDirectoryById.get('s1')).toBe('D:/scanned');
  });

  it('routes a stale-indexed event to the ACTIVE store only for the viewed session', () => {
    const index = createRoutingIndex();
    registerSessionDirectory(index, 's1', 'D:/gone');
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      sessionID: 's1',
      activeSessionID: 's1',
      activeDirectory: 'D:/active',
      activeStoreExists: true,
    }))).toBe('D:/active');
    // a DIFFERENT session on a stale index stays un-routed (never a guess)
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      sessionID: 's2',
      activeSessionID: 's1',
      activeStoreExists: true,
    }))).toBe('global');
  });

  it('message-addressed payloads reach the part store and orphan events go to the active dir', () => {
    const index = createRoutingIndex();
    registerMessageSession(index, 'm1', 's1');
    registerSessionDirectory(index, 's1', 'D:/gone');
    // message-ONLY event (no sessionID): part-bucket store wins over index staleness
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      messageID: 'm1',
      findPartStore: (id) => (id === 'm1' ? 'D:/parts' : null),
      activeSessionID: 's1',
      activeStoreExists: true,
    }))).toBe('D:/parts');
    // orphan delta with a known session and an active store: route for materialization
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      messageID: 'm2',
      activeSessionID: 's1',
      activeStoreExists: true,
    }))).toBe('global');
  });

  it('single-store fallback wins before the raw directory; drops clean up', () => {
    const index = createRoutingIndex();
    registerMessageSession(index, 'm1', 's1');
    dropSession(index, 's1');
    expect(index.messageSessionById.has('m1')).toBe(false);
    expect(resolveDirectoryFromRoutingIndex(index, ctx({
      sessionID: 's1',
      singleStore: 'D:/only',
    }))).toBe('D:/only');
  });
});

describe('equality + ordering guards', () => {
  const session = (id: string, updated: number): Session => ({
    id,
    time: { created: updated - 1, updated },
  } as Session);

  it('siblings stale refreshes skip on recency', () => {
    expect(shouldSkipStaleSessionEvent(session('s1', 200), session('s1', 100))).toBe(true);
    expect(shouldSkipStaleSessionEvent(session('s1', 100), session('s1', 200))).toBe(false);
    expect(shouldSkipStaleSessionEvent(undefined, session('s1', 100))).toBe(false);
  });

  it('status equality compares retry metadata too', () => {
    expect(areSessionStatusesEqual(undefined, { type: 'idle' })).toBe(false);
    expect(areSessionStatusesEqual({ type: 'busy' }, { type: 'busy' })).toBe(true);
    expect(areSessionStatusesEqual({ type: 'retry', attempt: 1, message: 'a', next: 3 }, { type: 'retry', attempt: 2, message: 'a', next: 3 })).toBe(false);
  });

  it('suffix-overlap append merges repeating deltas without duplication', () => {
    expect(appendNonOverlappingDelta('', 'abc')).toBe('abc');
    expect(appendNonOverlappingDelta('abc', '')).toBe('abc');
    expect(appendNonOverlappingDelta('abc', 'de')).toBe('abcde');
    expect(appendNonOverlappingDelta('ab', 'bab')).toBe('abab');
    expect(appendNonOverlappingDelta('Hello', 'He')).toBe('HelloHe'); // current does not end with the delta's leading edge
  });

  it('delta field relation marks only related fields', () => {
    expect(getUpdatedDeltaFields(
      { id: 'p', messageID: 'm', type: 'text', text: 'He' } as never,
      { id: 'p', messageID: 'm', type: 'text', text: 'Hello' } as never,
    )).toEqual(['text']);
    expect(getUpdatedDeltaFields({ id: 'p', messageID: 'm', type: 'text' } as never, { id: 'p', messageID: 'm', type: 'text' } as never)).toEqual([]);
  });

  it('tool preservation only blocks non-terminal, end-less overwrites', () => {
    const terminal = { id: 'p', messageID: 'm', type: 'tool', state: { status: 'completed' } } as never;
    const running = { id: 'p', messageID: 'm', type: 'tool', state: { status: 'running' } } as never;
    expect(shouldPreserveExistingPart(terminal, running)).toBe(true);
    expect(shouldPreserveExistingPart(terminal, { id: 'p', messageID: 'm', type: 'tool', state: { status: 'error' } } as never)).toBe(false);
    expect(shouldPreserveExistingPart(undefined, running)).toBe(false);
  });

  it('binary upsert replaces in place and removes deterministically', () => {
    const list: { id: string }[] = [];
    expect(upsertById(list, { id: 'b' }).inserted).toBe(true);
    expect(upsertById(list, { id: 'a' }).inserted).toBe(true);
    expect(binarySearchIndex(list, 'a').found).toBe(true);
    expect(upsertById(list, { id: 'a' }).inserted).toBe(false);
    expect(removeById(list, 'b')).toBe(true);
    expect(removeById(list, 'b')).toBe(false);
    expect(list.map((item) => item.id)).toEqual(['a']);
  });
});

export type { EventRoutingIndex };
