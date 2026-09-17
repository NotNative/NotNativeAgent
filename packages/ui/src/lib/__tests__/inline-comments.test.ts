// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { extractLines, lineOffsets, lineRangeFromOffsets } from '../inline-comments.ts';

describe('inline-comment range helpers (doc 06 §10.2 v1)', () => {
  const CONTENT = 'alpha\nbravo charlie\ndelta\n';

  it('maps caret offsets to the covering line range', () => {
    expect(lineOffsets(CONTENT)).toEqual([0, 6, 20, 26]); // trailing newline opens the empty final line
    expect(lineRangeFromOffsets(CONTENT, 6, 19)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineRangeFromOffsets(CONTENT, 0, CONTENT.length)).toEqual({ startLine: 0, endLine: 2 });
  });

  it('normalizes and rejects collapsed or inverted selections', () => {
    expect(lineRangeFromOffsets(CONTENT, 4, 4)).toBeNull();
    expect(lineRangeFromOffsets(CONTENT, 3, 0)).toBeNull();
    expect(lineRangeFromOffsets(CONTENT, -1, 3)).toBeNull();
  });

  it('clamps the empty tail line of a selection that ends at a line start', () => {
    // selecting THROUGH the trailing newline lands on the blank final line: the blank tail is trimmed
    expect(lineRangeFromOffsets(CONTENT, 6, CONTENT.length)).toEqual({ startLine: 1, endLine: 2 });
    const withBlankTail = 'one\ntwo\n\n';
    expect(lineRangeFromOffsets(withBlankTail, 0, withBlankTail.length)).toEqual({ startLine: 0, endLine: 1 }); // two blank tails trimmed
  });

  it('extracts code for the range from the same snapshot', () => {
    expect(extractLines(CONTENT, 1, 1)).toBe('bravo charlie');
    expect(extractLines(CONTENT, 0, 2)).toBe('alpha\nbravo charlie\ndelta');
    expect(extractLines(CONTENT, 2, 0)).toBe('alpha\nbravo charlie\ndelta'); // normalized start<=end
    expect(extractLines('x', 5, 9)).toBe('x'); // clamped to the document
  });
});
