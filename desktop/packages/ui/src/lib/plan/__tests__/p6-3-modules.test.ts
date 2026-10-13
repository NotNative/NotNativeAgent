// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom — P6-3 pure modules: §3.4 positions (100 FIFO,
 * sticky restore), §8.2/§8.3 plan save queue (revision dedup, LIVE-runtime
 * drop, failed-watermark, pendingFor/reset), §7 worktree ordering, §10.1
 * drafts (limits, byte-indexed envelope bound, reload roundtrip). */
import { beforeEach, describe, expect, it } from 'vitest';
import { clampCaret, getFilePosition, positionCount, saveFilePosition, __resetPositionsForTests } from '../../files/positions.ts';
import { createPlanSaveQueue, planEpochFor, sessionPlanPath } from '../../plan/save-queue.ts';
import { orderWorktrees, useWorktreeOrderStore } from '../../../components/worktrees/WorktreesView.tsx';
import {
  compactEnvelope, consumeDrafts, restoreDrafts, useInlineCommentDrafts,
  __reloadDraftsForTests, __resetDraftsForTests, type CommentDraft, type SessionSlot,
} from '../../comments/drafts'; // eslint-disable-line
import { getRuntimeKey } from '../../runtime-switch.ts';

beforeEach(() => {
  __resetPositionsForTests();
  __resetDraftsForTests();
  useWorktreeOrderStore.setState({ orders: {} });
  localStorage.clear();
});

describe('file positions (doc 06 §3.4)', () => {
  it('saves and re-applies positions keyed by runtime/root/path (sticky §3.4)', () => {
    saveFilePosition('local', '/repo', 'a.ts', { scroll: 40, anchor: 10, head: 14 });
    expect(getFilePosition('local', '/repo', 'a.ts')?.scroll).toBe(40);
    expect(getFilePosition('local', '/repo', 'a.ts')?.scroll).toBe(40); // sticky until the next destroy-save
    expect(getFilePosition('remote', '/repo', 'a.ts')).toBeNull(); // runtime-scoped
    saveFilePosition('remote', '/repo', 'a.ts', { scroll: 5, anchor: 0, head: 0 });
    expect(getFilePosition('remote', '/repo', 'a.ts')?.scroll).toBe(5);
    expect(getFilePosition('local', '/repo', 'a.ts')?.scroll).toBe(40); // keys are independent
  });

  it('caps the map at 100 FIFO with re-save refreshing recency', () => {
    for (let index = 0; index < 108; index += 1) {
      saveFilePosition('local', '/repo', `f${index}.ts`, { scroll: index, anchor: 0, head: 0 });
    }
    expect(positionCount()).toBe(100);
    expect(getFilePosition('local', '/repo', 'f0.ts')).toBeNull(); // evicted
    expect(getFilePosition('local', '/repo', 'f107.ts')).not.toBeNull();
    saveFilePosition('local', '/repo', 'f50.ts', { scroll: 0, anchor: 0, head: 0 });
    expect(getFilePosition('local', '/repo', 'f7.ts')).toBeNull(); // re-save pushed f50 to the tail
  });

  it('clamps restored carets into the document', () => {
    expect(clampCaret(-5, 10)).toBe(0);
    expect(clampCaret(30, 10)).toBe(10);
    expect(clampCaret(Number.NaN, 10)).toBe(0);
  });
});

describe('plan save queue (doc 06 §8.2/§8.3)', () => {
  it('dedups revisions at or below the watermark and chains writes in order', async () => {
    const queue = createPlanSaveQueue();
    const writes: number[] = [];
    await queue.schedule('k', 1, async () => { writes.push(1); });
    await queue.schedule('k', 1, async () => { writes.push(1); }); // dedup: returns the current chain
    await queue.schedule('k', 2, async () => { writes.push(2); });
    expect(writes).toEqual([1, 2]);
  });

  it('a failed write clears its watermark; the exact revision retries', async () => {
    const queue = createPlanSaveQueue();
    const writes: number[] = [];
    await queue.schedule('k', 1, async () => { throw new Error('disk'); }).catch(() => undefined);
    await queue.schedule('k', 1, async () => { writes.push(1); });
    expect(writes).toEqual([1]);
  });

  it('a failed write clears its watermark ONLY while still latest (§8.2)', async () => {
    const queue = createPlanSaveQueue();
    const writes: number[] = [];
    let rejectFirst: (error: Error) => void = () => undefined;
    const gate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; }); // executor runs synchronously
    const first = queue.schedule('k', 1, () => gate);
    const second = queue.schedule('k', 2, async () => { writes.push(2); }); // watermark moves to 2 before rev 1 settles
    rejectFirst(new Error('disk'));
    await Promise.all([first.catch(() => undefined), second]);
    await queue.schedule('k', 1, async () => { writes.push(1); }).catch(() => undefined); // dedup: rev 1 <= watermark 2
    expect(writes).toEqual([2]); // the failed revision never re-runs under a newer watermark
  });

  it('drops a queued write when the runtime switched (per-key binding)', async () => {
    const queue = createPlanSaveQueue();
    let writes = 0;
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    queue.bindRuntime('k', 'local');
    const first = queue.schedule('k', 1, async () => { await gate; writes += 1; });
    await Promise.resolve(); // let write 1 start (captured 'local') before the switch
    const queued = queue.schedule('k', 2, async () => { writes += 1; }); // queued behind the held write, captured 'local'
    queue.bindRuntime('k', 'remote'); // the switch races in while rev 2 is queued
    releaseFirst();
    await Promise.all([first, queued]);
    expect(writes).toBe(1); // rev 1 wrote; rev 2 never wrote across connections (§8.2)
  });

  it('drops via the LIVE runtime source (embedded runtime keys cannot deadlock the check)', async () => {
    const queue = createPlanSaveQueue();
    let runtime = 'local';
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    queue.bindRuntimeSource(() => runtime);
    let writes = 0;
    const first = queue.schedule('k', 1, async () => { await gate; writes += 1; });
    await Promise.resolve(); // let write 1 start before the switch
    const queued = queue.schedule('k', 2, async () => { writes += 1; }); // captured 'local'
    runtime = 'remote'; // the switch lands before the queued write runs
    releaseFirst();
    await Promise.all([first, queued]);
    expect(writes).toBe(1);
  });

  it('pendingFor awaits settled writes and KEEPS the watermark; reset forgets it', async () => {
    const queue = createPlanSaveQueue();
    const writes: number[] = [];
    const first = queue.schedule('k', 1, async () => { writes.push(1); });
    const pending = queue.pendingFor('k');
    const raced = queue.schedule('k', 2, async () => { writes.push(2); }); // enqueued DURING pendingFor's await
    await Promise.all([pending, raced, first]);
    await queue.schedule('k', 2, async () => { writes.push(2); }).catch(() => undefined); // deduped: watermark retained
    expect(writes).toEqual([1, 2]);
    queue.reset('k'); // §8.1 fresh load
    await queue.schedule('k', 2, async () => { writes.push(3); });
    expect(writes).toEqual([1, 2, 3]);
  });

  it('pendingFor keeps the chain serialized when a schedule races the await', async () => {
    const queue = createPlanSaveQueue();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let releaseSecond: () => void = () => undefined;
    const gate1 = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const gate2 = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = queue.schedule('k', 1, async () => { await gate1; order.push('w1'); });
    const pending = queue.pendingFor('k'); // captures the chain while it is STILL pending
    const second = queue.schedule('k', 2, async () => { await gate2; order.push('w2'); });
    releaseFirst(); // w2 starts and holds; pendingFor resumes with w2 in flight
    await pending;
    const third = queue.schedule('k', 3, async () => { order.push('w3'); }); // must chain AFTER the raced-in w2
    releaseSecond();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['w1', 'w2', 'w3']); // w3 never ran while w2 was still held
  });

  it('session plan path follows the .opencode/plans contract (§8.5) with a stable v1 epoch', () => {
    expect(sessionPlanPath('/proj', 123, 'plan')).toContain('.opencode/plans/123-plan.md');
    expect(sessionPlanPath('C:\\proj', 123, 'plan')).toContain('.opencode\\plans\\123-plan.md');
    const first = sessionPlanPath('/repo', planEpochFor('/repo'), 'plan');
    expect(sessionPlanPath('/repo', planEpochFor('/repo'), 'plan')).toBe(first); // deterministic: the authored plan is found again
    expect(sessionPlanPath('/other', planEpochFor('/other'), 'plan')).not.toBe(first);
  });
});

describe('worktree ordering (doc 06 §7)', () => {
  it('known paths sort by stored order; unknown appended alphabetically', () => {
    const ordered = orderWorktrees(
      ['/w/c', '/w/a'],
      [{ path: '/w/b', branch: 'b' }, { path: '/w/a', branch: 'a' }, { path: '/w/c', branch: 'c' }],
    );
    expect(ordered.map((entry) => entry.path)).toEqual(['/w/c', '/w/a', '/w/b']);
  });

  it('persists the per-project order under the documented storage name', () => {
    useWorktreeOrderStore.getState().setOrder('/proj', ['/w/x']);
    expect(JSON.parse(localStorage.getItem('mobile-worktree-order')!)).toMatchObject({ '/proj': ['/w/x'] });
    expect(useWorktreeOrderStore.getState().orderFor('/none')).toEqual([]); // stable empty snapshot
  });
});

const DIR = '/demo';

function draftBase(): Omit<CommentDraft, 'id' | 'createdAt' | 'sessionKey'> {
  return { source: 'file', fileLabel: 'a.ts', startLine: 1, endLine: 2, code: 'x', language: 'ts', text: 'note' };
}

function slotKey(directory: string, sessionKey: string): string {
  return JSON.stringify([getRuntimeKey(), directory, sessionKey]);
}

describe('inline comment drafts (doc 06 §10.1)', () => {
  it('add/count/consume/restore round-trips with pinned identity', () => {
    const store = useInlineCommentDrafts.getState();
    const id = store.addDraft(DIR, 'sess_1', draftBase())!;
    expect(store.getDraftCount(DIR, 'sess_1')).toBe(1);
    const consumed = consumeDrafts(DIR, 'sess_1');
    expect(consumed.map((draft) => draft.id)).toEqual([id]);
    expect(store.getDraftCount(DIR, 'sess_1')).toBe(0);
    restoreDrafts(DIR, 'sess_1', consumed);
    expect(store.getDraftCount(DIR, 'sess_1')).toBe(1);
    const again = consumeDrafts(DIR, 'sess_1');
    expect(again.map((draft) => draft.id)).toEqual([id]); // restore preserved the pinned id through the roundtrip
    expect(store.addDraft(DIR, 'sess_1', draftBase(), { pinnedId: id })).toBe(id); // §10.1 pin support
  });

  it('caps drafts per session at 20 and sessions at 50 in the persisted envelope', () => {
    for (let index = 0; index < 60; index += 1) {
      useInlineCommentDrafts.getState().addDraft(`/dir-${index}`, 's', draftBase());
    }
    for (let index = 0; index < 24; index += 1) {
      useInlineCommentDrafts.getState().addDraft(DIR, 'sess_1', { ...draftBase(), text: `n${index}` });
    }
    expect(useInlineCommentDrafts.getState().getDraftCount(DIR, 'sess_1')).toBe(20); // oldest dropped
    const persisted = JSON.parse(localStorage.getItem('notnative.inlineComments.v3')!) as Record<string, SessionSlot>;
    expect(Object.keys(persisted).length).toBeLessThanOrEqual(50); // §10.1 session cap in the envelope
  });

  it('persists and re-hydrates across reloads', () => {
    useInlineCommentDrafts.getState().addDraft(DIR, 'sess_1', draftBase());
    expect(localStorage.getItem('notnative.inlineComments.v3')).not.toBeNull();
    __reloadDraftsForTests();
    expect(useInlineCommentDrafts.getState().getDraftCount(DIR, 'sess_1')).toBe(1);
  });

  it('the byte-indexed envelope bound TRULY holds: a lone oversize session sheds its oldest drafts', () => {
    const big = 'x'.repeat(700_000); // chars === bytes here; CJK content would only measure larger
    const drafts: CommentDraft[] = Array.from({ length: 4 }, (_, index) => ({
      id: `d${index}`, sessionKey: 'big', source: 'file', fileLabel: 'f', startLine: 1, endLine: 2,
      code: big, language: 'ts', text: 'note', createdAt: '2020',
    }));
    const slot: SessionSlot = { drafts, touchedAt: 1 };
    const compacted = compactEnvelope([[slotKey('/big', 'big'), slot]]);
    expect(new TextEncoder().encode(JSON.stringify(compacted)).length).toBeLessThanOrEqual(1_048_576);
    const kept = Object.values(compacted)[0];
    expect(kept?.drafts.at(-1)?.id).toBe('d3'); // shed oldest, kept the newest
    // the same bound applies on reload: an oversize persisted envelope TRIMS instead of wiping
    localStorage.setItem('notnative.inlineComments.v3', JSON.stringify({ [slotKey('/big', 'big')]: slot }));
    __reloadDraftsForTests();
    expect(useInlineCommentDrafts.getState().getDraftCount('/big', 'big')).toBe(1);
  });

  it('hydration validates per entry and keeps valid sessions next to invalid ones', () => {
    localStorage.setItem('notnative.inlineComments.v3', JSON.stringify({
      [slotKey(DIR, 'sess_1')]: {
        drafts: [{ id: 'a', sessionKey: 'sess_1', source: 'file', fileLabel: 'f', startLine: 1, endLine: 2, code: 'c', language: 'ts', text: 'ok', createdAt: '2020' }],
        touchedAt: 2,
      },
      broken: { drafts: [{ nonsense: true }], touchedAt: 3 },
    }));
    __reloadDraftsForTests();
    expect(useInlineCommentDrafts.getState().getDraftCount(DIR, 'sess_1')).toBe(1); // valid entry survives
    expect(useInlineCommentDrafts.getState().getDraftCount('/x', 'sess_1')).toBe(0); // invalid dropped
  });
});
