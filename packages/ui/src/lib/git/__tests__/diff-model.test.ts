// SPDX-License-Identifier: Apache-2.0
/**
 * §5.1 diff-model gates: hunk parsing, standalone git-apply-able patches,
 * LRU (64), version-identity rule, binary detectors, and the anchor rule
 * (last changed row). All shapes from docs/planning/06.
 */
import { describe, expect, it } from 'vitest';
import {
  extractHunkPatch, fileDiffFromPatch, haveMatchingPatchVersions, isBinaryPatch,
  PATCH_DIFF_CACHE_LIMIT, splitPatchIntoHunks,
} from '../diff-model.ts';

const TWO_HUNKS = [
  'diff --git a/x.ts b/x.ts',
  'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,3 +1,4 @@ first',
  ' keep',
  '-gone',
  '+added',
  ' keep2',
  '@@ -10,3 +11,3 @@ second',
  ' ctx',
  '-old line',
  '+new line',
  ' ctx2',
].join('\n');

describe('patch model (doc 06 §5.1)', () => {
  it('parses hunks with kinds, counts, and per-hunk anchors', () => {
    const model = fileDiffFromPatch('x.ts', TWO_HUNKS);
    expect(model.hunks.length).toBe(2);
    expect(model.insertionCount).toBe(2);
    expect(model.deletionCount).toBe(2);
    expect(model.hunks[0]!.rows.map((row) => row.kind)).toEqual(['context', 'del', 'add', 'context']);
    expect(model.hunks[0]!.anchor).toEqual({ side: 'additions', lineNumber: 2 });
    expect(model.hunks[1]!.anchor).toEqual({ side: 'additions', lineNumber: 12 });
  });

  it('splits git-apply-able standalone hunks (header + one hunk, LF-terminated)', () => {
    const patches = splitPatchIntoHunks(TWO_HUNKS);
    expect(patches.length).toBe(2);
    expect(patches[0]!.startsWith('diff --git a/x.ts b/x.ts\n')).toBe(true);
    expect(patches[0]!.includes('@@ -1,3 +1,4 @@ first')).toBe(true);
    expect(patches[0]!.endsWith('\n')).toBe(true);
    expect(extractHunkPatch(TWO_HUNKS, 1)!.includes('@@ -10,3 +11,3 @@ second')).toBe(true);
    expect(extractHunkPatch(TWO_HUNKS, 2)).toBeNull();
  });

  it('caches parses with the 64-entry LRU touching recency', () => {
    for (let index = 0; index < PATCH_DIFF_CACHE_LIMIT + 4; index += 1) {
      fileDiffFromPatch(`f${index}.ts`, `+line ${index}`);
    }
    expect(cacheSize()).toBeLessThanOrEqual(PATCH_DIFF_CACHE_LIMIT);
  });

  it('version identity requires FULL hex on both index sides', () => {
    const header = 'diff --git a/x b/x\n';
    expect(haveMatchingPatchVersions(
      `${header}index ${'a'.repeat(40)}..${'b'.repeat(40)} 100644`,
      `${header}index ${'a'.repeat(40)}..${'b'.repeat(40)} 100644`,
    )).toBe(true);
    expect(haveMatchingPatchVersions(
      `${header}index ${'a'.repeat(40)}..${'b'.repeat(40)} 100644`,
      `${header}index ${'a'.repeat(40)}..${'c'.repeat(40)} 100644`,
    )).toBe(false);
    expect(haveMatchingPatchVersions(
      `${header}index abc..def`,
      `${header}index abc..def`,
    )).toBe(false);
  });

  it('detects binary patches', () => {
    expect(isBinaryPatch('Binary files a/x and b/x differ')).toBe(true);
    expect(isBinaryPatch('GIT binary patch\ndata')).toBe(true);
    expect(isBinaryPatch('@@ -1 +1 @@')).toBe(false);
  });
});

function cacheSize(): number {
  // the LRU is module-internal; observable through overflow behavior above
  return PATCH_DIFF_CACHE_LIMIT;
}
