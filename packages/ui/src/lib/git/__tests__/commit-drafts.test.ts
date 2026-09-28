// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { commitDraftScope, useCommitDraftStore } from '../commit-drafts.ts';

beforeEach(() => useCommitDraftStore.setState({ drafts: {} }));

describe('commit drafts', () => {
  it('normalizes drive spelling but isolates runtime and workspace', () => {
    expect(commitDraftScope('local', 'c:\\repo\\')).toBe(commitDraftScope('local', 'C:/repo'));
    expect(commitDraftScope('local', 'C:/repo')).not.toBe(commitDraftScope('remote', 'C:/repo'));
    expect(commitDraftScope('local', 'C:/repo')).not.toBe(commitDraftScope('local', 'C:/else'));
  });

  it('does not erase a newer draft when an older commit succeeds', () => {
    const store = useCommitDraftStore.getState();
    store.setDraft('scope', 'first');
    store.setDraft('scope', 'revised');
    store.clearIfMatches('scope', 'first');
    expect(useCommitDraftStore.getState().drafts.scope).toBe('revised');
    store.clearIfMatches('scope', 'revised');
    expect(useCommitDraftStore.getState().drafts.scope).toBeUndefined();
  });

  it('retains at most twenty workspace drafts and drops oldest entries', () => {
    const store = useCommitDraftStore.getState();
    for (let index = 0; index < 21; index += 1) store.setDraft(`scope-${index}`, `draft-${index}`);
    expect(Object.keys(useCommitDraftStore.getState().drafts)).toHaveLength(20);
    expect(useCommitDraftStore.getState().drafts['scope-0']).toBeUndefined();
    expect(useCommitDraftStore.getState().drafts['scope-20']).toBe('draft-20');
  });
});
