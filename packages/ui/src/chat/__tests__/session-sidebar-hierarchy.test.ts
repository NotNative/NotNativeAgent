// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Session } from '../../lib/nnd/types.ts';
import type { SessionFolder } from '../../lib/session-folders.ts';
import { sidebarHierarchy } from '../session-sidebar-hierarchy.ts';

const session = (id: string, parentID?: string): Session => ({ id, parentID, directory: '/work', title: id } as Session);
const folder = (id: string, sessionIds: string[]): SessionFolder => ({ id, name: id, sessionIds, createdAt: 1 });

describe('delegated session navigation', () => {
  it('places a recent child below its older parent even when the parent falls past the recent cap', () => {
    const result = sidebarHierarchy([session('child', 'parent'), session('other'), session('parent')], [], 2);
    expect(result.visible).toEqual(['other', 'parent', 'child']);
    expect(result.depth.get('child')).toBe(1);
    expect(result.unavailableParent).toEqual([]);
  });

  it('keeps children inside their parent folder without recording new folder membership', () => {
    const result = sidebarHierarchy([session('child', 'parent'), session('parent')], [folder('f1', ['parent'])], 50);
    expect(result.visible).toEqual(['parent', 'child']);
    expect(result.folder.get('child')).toBe('f1');
    expect(result.depth.get('child')).toBe(1);
    expect(result.unfiled).toEqual([]);
  });

  it('separates an unavailable parent subtree without attaching it to an unrelated root', () => {
    const result = sidebarHierarchy([session('other'), session('grandchild', 'child'), session('child', 'deleted')], [], 50);
    expect(result.unfiled).toEqual(['other']);
    expect(result.unavailableParent).toEqual(['child', 'grandchild']);
    expect(result.depth.get('grandchild')).toBe(1);
  });

  it('keeps an explicitly filed child with an unavailable parent in its folder', () => {
    const result = sidebarHierarchy([session('grandchild', 'child'), session('child', 'deleted')], [folder('f1', ['child'])], 50);
    expect(result.folder.get('child')).toBe('f1');
    expect(result.folder.get('grandchild')).toBe('f1');
    expect(result.unavailableParent).toEqual([]);
    expect(result.unfiled).toEqual([]);
  });

  it('does not recurse indefinitely on malformed cyclic parent metadata', () => {
    const result = sidebarHierarchy([session('a', 'b'), session('b', 'a')], [], 50);
    expect(result.visible).toEqual(['a', 'b']);
    expect(result.unavailableParent).toEqual([]);
  });

  it('retains an older pin beyond the recent cap without moving it ahead of newer rows', () => {
    const result = sidebarHierarchy([session('new'), session('middle'), session('pinned')], [], 2, new Set(['pinned']));
    expect(result.visible).toEqual(['new', 'middle', 'pinned']);
  });

  it('retains a pinned child and its parent beyond the recent cap', () => {
    const result = sidebarHierarchy([session('new'), session('child', 'parent'), session('parent')], [], 1, new Set(['child']));
    expect(result.visible).toEqual(['new', 'parent', 'child']);
    expect(result.depth.get('child')).toBe(1);
  });
});
