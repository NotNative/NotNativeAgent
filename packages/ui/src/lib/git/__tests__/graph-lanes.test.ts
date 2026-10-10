// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { computeCommitLanes } from '../graph-lanes.ts';

describe('computeCommitLanes', () => {
  it('keeps a linear history on lane 0', () => {
    const rows = computeCommitLanes([
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: ['c'] },
      { hash: 'c', parents: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows[0]!.edges).toEqual([{ from: 0, to: 0 }]);
    expect(rows[2]!.edges).toEqual([]);
  });

  it('opens a new lane for a branch point and curves back into it', () => {
    const rows = computeCommitLanes([
      { hash: 'merge', parents: ['main2', 'feat'] },
      { hash: 'main2', parents: ['base'] },
      { hash: 'feat', parents: ['base'] },
      { hash: 'base', parents: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[0]!.edges).toEqual([{ from: 0, to: 0 }, { from: 0, to: 1 }]);
    expect(rows[2]!.edges).toEqual([{ from: 1, to: 0 }]);
  });

  it('keeps lanes stable for commits listed out of parent order', () => {
    const rows = computeCommitLanes([
      { hash: 'tip', parents: ['mid'] },
      { hash: 'other', parents: ['mid'] },
      { hash: 'mid', parents: [] },
    ]);
    expect(rows[2]!.lane).toBe(0); // first claimant wins the lane
    expect(rows[1]!.edges).toEqual([{ from: 1, to: 0 }]);
  });

  it('allocates one lane per row when parents are absent from the window', () => {
    const rows = computeCommitLanes([
      { hash: 'a', parents: ['outside'] },
      { hash: 'b', parents: ['also-outside'] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 1]);
  });

  it('reuses freed lanes after a fork rejoins, keeping laneCount bounded', () => {
    const rows = computeCommitLanes([
      { hash: 'm1', parents: ['m2', 'f1'] },
      { hash: 'm2', parents: ['m3'] },
      { hash: 'f1', parents: ['m3'] },
      { hash: 'm3', parents: ['m4'] },
      { hash: 'm4', parents: ['f2'] },
      { hash: 'f2', parents: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(rows[5]!.laneCount).toBe(2); // lane 1 was freed after the rejoin, not leaked
  });

  it('does not hold lanes open for parents that already appeared earlier', () => {
    const rows = computeCommitLanes([
      { hash: 'ancestor', parents: [] },
      { hash: 'child1', parents: ['ancestor'] }, // clock-skewed ordering
      { hash: 'child2', parents: ['ancestor'] },
      { hash: 'child3', parents: ['ancestor'] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0, 0]);
    expect(rows.every((row) => row.laneCount === 1)).toBe(true);
  });
});
