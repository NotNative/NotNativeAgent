// SPDX-License-Identifier: Apache-2.0
/** Scope-separation boundary (W-28): global and directory scopes never merge. */
import { describe, expect, it } from 'vitest';
import { createDirectoryStore } from '../child-store.ts';
import { assertDirectoryPatch, assertGlobalPatch, directoryStateLeaksGlobal, scopeViolations } from '../scope-separation.ts';
import { useGlobalSessionsStore } from '../global-stores.ts';
import type { SyncState } from '../types.ts';

describe('scope separation (W-28)', () => {
  it('directory patches accept directory scope and reject global-sidecar keys', () => {
    const store = createDirectoryStore();
    store.getState().patch({ session_status: { s1: { type: 'idle' } }, sessionStatusReady: true });
    expect(store.getState().session_status['s1']?.type).toBe('idle');
    expect(() => store.getState().patch({ active: [] } as unknown as Partial<SyncState>)).toThrow(/leaks global scope.*active/u);
    expect(() => store.getState().patch({ statusById: {}, hasLoaded: true } as unknown as Partial<SyncState>))
      .toThrow(/leaks global scope: statusById, hasLoaded/u);
    expect((store.getState() as unknown as { active?: unknown }).active).toBeUndefined(); // nothing leaked into state
  });

  it('global patches reject directory-owned keys and the validators report them', () => {
    expect(() => assertGlobalPatch({ message: {} as never })).toThrow(/leaks directory scope: message/u);
    expect(() => assertGlobalPatch({ part: {} as never, permission: {} as never }))
      .toThrow(/leaks directory scope: part, permission/u);
    expect(scopeViolations({ active: [], session_diff: {} }, 'directory')).toEqual(['active']);
    expect(scopeViolations({ active: [], session_diff: {} }, 'global')).toEqual(['session_diff']);
    expect(scopeViolations({ session: [] }, 'directory')).toEqual([]); // `session` is legal in BOTH scopes
  });

  it('the real global sidecar keeps carrying the cross-directory cache without directory transcripts', () => {
    useGlobalSessionsStore.setState({ active: [], archived: [], hasLoaded: true, status: 'ready' });
    expect(useGlobalSessionsStore.getState().active).toEqual([]);
    expect(directoryStateLeaksGlobal(useGlobalSessionsStore.getState() as unknown as SyncState))
      .toEqual(expect.arrayContaining(['active', 'archived', 'hasLoaded'])); // sidecar fields are sidecar-owned, by design detectable
    useGlobalSessionsStore.getState().reset();
  });
});
