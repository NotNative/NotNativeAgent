// SPDX-License-Identifier: Apache-2.0
/** Diff scroll anchor selection + restoration (doc 06 §5.8). */
import { describe, expect, it } from 'vitest';
import { findDiffScrollAnchor, getRestoredDiffScrollTop } from '../diff-scroll-anchor.ts';

describe('findDiffScrollAnchor (§5.8)', () => {
  it('anchors to the section nearest above the viewport top', () => {
    const anchor = findDiffScrollAnchor(500, [
      { path: 'a.ts', top: 100 },
      { path: 'b.ts', top: 400 },
      { path: 'c.ts', top: 900 },
    ]);
    expect(anchor).toEqual({ path: 'b.ts', topOffset: -100 });
  });

  it('falls forward to the first section below when nothing is above', () => {
    const anchor = findDiffScrollAnchor(50, [
      { path: 'c.ts', top: 900 },
      { path: 'a.ts', top: 100 },
    ]);
    expect(anchor).toEqual({ path: 'a.ts', topOffset: 50 });
  });

  it('returns null without sections and picks the highest equal-section match', () => {
    expect(findDiffScrollAnchor(10, [])).toBeNull();
    expect(findDiffScrollAnchor(20, [{ path: 'a.ts', top: 20 }])).toEqual({ path: 'a.ts', topOffset: 0 });
  });
});

describe('getRestoredDiffScrollTop (§5.8)', () => {
  it('compensates the anchor shift and clamps to [0, max]', () => {
    expect(getRestoredDiffScrollTop(300, -100, -140, 900)).toBe(260);
    expect(getRestoredDiffScrollTop(300, -100, 40, 900)).toBe(440);
    expect(getRestoredDiffScrollTop(300, -100, 9999, 900)).toBe(900);
    expect(getRestoredDiffScrollTop(300, -100, -9999, 900)).toBe(0);
  });
});
