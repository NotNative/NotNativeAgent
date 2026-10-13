// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Tabs store gates (doc 06 §2.6): select-and-open, 50-cap, prefix removal
 * (rename/delete subtree), selection fallback to openPaths[0], expansion
 * cap, runtime snapshot switch, and the persistence envelope (versioned).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_OPEN_PATHS_PER_ROOT, MAX_RUNTIME_SNAPSHOTS, effectiveSelectedPath, useFilesViewTabsStore,
} from '../tabs-store.ts';

const ROOT = '/repo';
const RUNTIME = 'local';

beforeEach(() => {
  localStorage.clear();
  useFilesViewTabsStore.getState().__resetForTests();
});

describe('tabs store (§2.6)', () => {
  it('select and open are the same action; removal falls back to openPaths[0]', () => {
    const store = useFilesViewTabsStore.getState();
    store.setSelectedPath(ROOT, '/repo/a.ts', RUNTIME);
    store.setSelectedPath(ROOT, '/repo/b.ts', RUNTIME);
    expect(useFilesViewTabsStore.getState().byRoot[ROOT]!.openPaths).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(effectiveSelectedPath(ROOT)).toBe('/repo/b.ts');
    useFilesViewTabsStore.getState().removeOpenPath(ROOT, '/repo/b.ts');
    expect(effectiveSelectedPath(ROOT)).toBe('/repo/a.ts'); // selection falls back
  });

  it('open paths cap at 50 with last-N truncation', () => {
    const store = useFilesViewTabsStore.getState();
    for (let index = 0; index < MAX_OPEN_PATHS_PER_ROOT + 5; index += 1) {
      store.setSelectedPath(ROOT, `/repo/f${index}.ts`, RUNTIME);
    }
    const open = useFilesViewTabsStore.getState().byRoot[ROOT]!.openPaths;
    expect(open.length).toBe(MAX_OPEN_PATHS_PER_ROOT);
    expect(open[0]).toBe('/repo/f5.ts'); // first five pruned
  });

  it('rename/delete drops open tabs + expansion under the prefix', () => {
    const store = useFilesViewTabsStore.getState();
    store.setSelectedPath(ROOT, '/repo/sub/a.ts', RUNTIME);
    store.setSelectedPath(ROOT, '/repo/keep.ts', RUNTIME);
    useFilesViewTabsStore.getState().toggleExpandedPath(ROOT, '/repo/sub');
    useFilesViewTabsStore.getState().removeOpenPathsByPrefix(ROOT, '/repo/sub');
    const doc = useFilesViewTabsStore.getState().byRoot[ROOT]!;
    expect(doc.openPaths).toEqual(['/repo/keep.ts']);
    expect(doc.expandedPaths).toEqual([]);
    expect(doc.selectedPath).toBe('/repo/keep.ts');
  });

  it('expansion cap 500 and collapse-all', () => {
    const store = useFilesViewTabsStore.getState();
    for (let index = 0; index < 505; index += 1) {
      useFilesViewTabsStore.getState().toggleExpandedPath(ROOT, `/repo/d${index}`);
    }
    let expanded = useFilesViewTabsStore.getState().byRoot[ROOT]!.expandedPaths;
    expect(expanded.length).toBe(500);
    useFilesViewTabsStore.getState().collapseAllExpandedPaths(ROOT);
    expanded = useFilesViewTabsStore.getState().byRoot[ROOT]!.expandedPaths;
    expect(expanded).toEqual([]);
  });

  it('runtime switch snapshots the live map and loads the target runtime', () => {
    const store = useFilesViewTabsStore.getState();
    store.setSelectedPath(ROOT, '/repo/a.ts', RUNTIME);
    store.resetForRuntimeSwitch('url:http://b.test');
    const remoteRoot = '/other/repo';
    useFilesViewTabsStore.getState().setSelectedPath(remoteRoot, '/other/repo/x.ts', 'url:http://b.test');
    expect(useFilesViewTabsStore.getState().activeRuntimeKey).toBe('url:http://b.test');
    expect(useFilesViewTabsStore.getState().byRoot[remoteRoot]!.openPaths).toEqual(['/other/repo/x.ts']);
    // switching back restores the snapshot
    useFilesViewTabsStore.getState().resetForRuntimeSwitch(RUNTIME);
    expect(useFilesViewTabsStore.getState().byRoot[ROOT]!.openPaths).toEqual(['/repo/a.ts']);
  });

  it('runtime snapshots are bounded at 8', () => {
    const store = useFilesViewTabsStore.getState();
    for (let index = 0; index < 10; index += 1) {
      store.resetForRuntimeSwitch(`url:http://r${index}.test`);
    }
    expect(Object.keys(useFilesViewTabsStore.getState().runtimeSnapshots).length).toBeLessThanOrEqual(MAX_RUNTIME_SNAPSHOTS);
  });

  it('persists the versioned envelope on mutations', () => {
    useFilesViewTabsStore.getState().setSelectedPath(ROOT, '/repo/a.ts', RUNTIME);
    const raw = JSON.parse(localStorage.getItem('files-view-tabs-store')!);
    expect(raw.version).toBe(3);
    expect(raw.activeRuntimeKey).toBe(RUNTIME);
  });
});
