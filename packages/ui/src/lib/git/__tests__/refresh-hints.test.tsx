// SPDX-License-Identifier: Apache-2.0
/**
 * Refresh-hint bus (doc 06 §5.9/§11.4 + §13#1): delivery, buffer merging
 * with the path cap, and the visibility-gated replay contract (hidden:
 * accumulate; reveal: replay merged once; visible: coalesced macrotasks).
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  publishReviewRefresh, subscribeReviewRefresh, useReviewRefreshHints,
  ReviewRefreshBuffer, __resetReviewRefreshForTests, type ReviewRefreshHint,
} from '../refresh-hints.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

afterEach(() => {
  __resetReviewRefreshForTests();
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
});

function flushMacrotask(): Promise<void> {
  return new Promise((done) => { setTimeout(done, 10); });
}

async function mountHintHarness(initialVisible: boolean, replays: ReviewRefreshHint[]): Promise<{ setVisible: (value: boolean) => void }> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  let visible = initialVisible;
  const renderOnce = (): Promise<void> => new Promise((done) => {
    rootHandle!.render(<Consumer visible={visible} />); // React 19 render(): flush on the next macrotask
    setTimeout(done, 0);
  });
  function Consumer({ visible }: { visible: boolean }): null {
    useReviewRefreshHints('/repo', visible, (hint) => { replays.push(hint); });
    return null;
  }
  await act(async () => { await renderOnce(); });
  return {
    async setVisible(next: boolean): Promise<void> {
      visible = next;
      await act(async () => { await renderOnce(); }); // reveal effects flush before assertions
    },
  };
}

describe('refresh hints (doc 06 §11 minimal port)', () => {
  it('publishes to every live listener and respects unsubscribes', () => {
    const seenA: ReviewRefreshHint[] = [];
    const seenB: ReviewRefreshHint[] = [];
    const a = subscribeReviewRefresh((hint) => seenA.push(hint));
    subscribeReviewRefresh((hint) => seenB.push(hint))();
    publishReviewRefresh('/repo', ['a.ts'], 'file-save');
    publishReviewRefresh('/repo', null, 'fs-mutation');
    expect(seenA.map((hint) => hint.reasons)).toEqual([['file-save'], ['fs-mutation']]);
    expect(seenA[1]!.paths).toBeNull();
    expect(seenB).toEqual([]);
    a();
    publishReviewRefresh('/repo', ['b.ts'], 'git-mutation');
    expect(seenA.length).toBe(2);
  });

  it('merges buffered hints: union of paths, reason set, null-paths wins, capped at 128', () => {
    const buffer = new ReviewRefreshBuffer('/repo');
    buffer.add('/repo', ['a.ts', 'b.ts'], 'file-save');
    buffer.add('/repo', ['b.ts', 'c.ts'], 'fs-mutation');
    const merged = buffer.drain();
    expect(merged).not.toBeNull();
    expect(merged!.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(merged!.reasons).toEqual(['file-save', 'fs-mutation']);
    expect(buffer.__isEmptyForTests()).toBe(true);

    const nullFirst = new ReviewRefreshBuffer('/repo');
    nullFirst.add('/repo', ['a.ts'], 'file-save');
    nullFirst.add('/repo', null, 'git-mutation');
    expect(nullFirst.drain()!.paths).toBeNull();

    const capped = new ReviewRefreshBuffer('/repo');
    capped.add('/repo', Array.from({ length: 130 }, (_, index) => `f${index}.ts`), 'file-save');
    expect(capped.drain()!.paths).toBeNull();

    const foreign = new ReviewRefreshBuffer('/repo');
    foreign.add('/elsewhere', ['x.ts'], 'file-save');
    expect(foreign.drain()).toBeNull();
  });

  it('buffers while hidden and replays the merge once on reveal', async () => {
    const replays: ReviewRefreshHint[] = [];
    const harness = await mountHintHarness(false, replays);
    act(() => publishReviewRefresh('/repo', ['a.ts'], 'file-save'));
    act(() => publishReviewRefresh('/repo', ['b.ts'], 'git-mutation'));
    await flushMacrotask();
    expect(replays).toEqual([]); // hidden: nothing replays
    act(() => publishReviewRefresh('/other', ['x.ts'], 'file-save')); // foreign dir ignored
    await harness.setVisible(true);
    expect(replays.length).toBe(1);
    expect(replays[0]!.paths).toEqual(['a.ts', 'b.ts']);
    expect(replays[0]!.reasons).toEqual(['file-save', 'git-mutation']);
  });

  it('replays coalesced arrivals while visible on the next macrotask', async () => {
    const replays: ReviewRefreshHint[] = [];
    await mountHintHarness(true, replays);
    act(() => publishReviewRefresh('/repo', ['a.ts'], 'file-save'));
    act(() => publishReviewRefresh('/repo', ['a.ts', 'b.ts'], 'file-save'));
    await flushMacrotask();
    expect(replays.length).toBe(1);
    expect(replays[0]!.paths).toEqual(['a.ts', 'b.ts']);
    await flushMacrotask();
    expect(replays.length).toBe(1);
  });
});
