// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseDeletionPage } from '../activity-tombstones.ts';

const row = (sequence: number) => ({ sequence, sessionID: `s${sequence}`, createdAt: 10,
  deletedAt: 20, kind: 'deleted' });

describe('owner-scoped deletion pages', () => {
  it('accepts a bounded contiguous retained page without claiming full history', () => {
    expect(parseDeletionPage({ status: 'page', floor: 2, nextCursor: 4, records: [row(3), row(4)],
      historyComplete: false }, 2)?.records.map((item) => item.sequence)).toEqual([3, 4]);
    expect(parseDeletionPage({ status: 'page', floor: 2, nextCursor: 4, records: [row(3), row(4)],
      historyComplete: true }, 2)).toBeNull();
  });

  it('permits withheld intent sequences but rejects duplicate and forged cursors', () => {
    expect(parseDeletionPage({ status: 'page', floor: 0, nextCursor: 3, records: [row(2), row(3)],
      historyComplete: false }, 0)?.records).toHaveLength(2);
    expect(parseDeletionPage({ status: 'page', floor: 0, nextCursor: 1, records: [row(1), row(1)],
      historyComplete: false }, 0)).toBeNull();
    expect(parseDeletionPage({ status: 'page', floor: 0, nextCursor: 4, records: [row(1)],
      historyComplete: false }, 0)).toBeNull();
    expect(parseDeletionPage({ status: 'gap', floor: 2, nextCursor: null, records: [],
      historyComplete: false }, 0)?.status).toBe('gap');
    expect(parseDeletionPage({ status: 'gap', floor: 0, nextCursor: null, records: [],
      historyComplete: false }, 0)).toBeNull();
  });
});
