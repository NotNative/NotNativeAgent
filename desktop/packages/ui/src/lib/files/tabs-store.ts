// SPDX-License-Identifier: Apache-2.0
/**
 * Open-file tabs store (doc 06 §2.6): per-root open/selection/expanded with
 * runtime snapshots + hard limits (20 roots / 50 open / 500 expanded /
 * 4,096-char paths / 90-day root TTL / 8 runtime snapshots). Selection and
 * open are the SAME action (§2.6); removal falls selection back to the
 * first open path. Persisted to `files-view-tabs-store` (version 3;
 * snapshots persisted, not the live map) with a hand-rolled localStorage
 * envelope (repo pattern; sanitized-shape contract unchanged).
 */
import { create } from 'zustand';

export const MAX_ROOTS = 20;
export const MAX_OPEN_PATHS_PER_ROOT = 50;
export const MAX_EXPANDED_PATHS_PER_ROOT = 500;
export const MAX_PATH_LENGTH = 4096;
export const MAX_RUNTIME_SNAPSHOTS = 8;
export const ROOT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface TabsDoc {
  openPaths: string[];
  selectedPath: string | null;
  expandedPaths: string[];
}

interface RootTabs extends TabsDoc {
  touchedAt: number;
}

const STORAGE_KEY = 'files-view-tabs-store';
const STORAGE_VERSION = 3;

interface PersistedShape {
  activeRuntimeKey: string;
  runtimeSnapshots: Record<string, { byRoot: Record<string, RootTabs>; updatedAt: number }>;
}

export function isWindowsLikePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith('\\\\');
}

function samePath(a: string, b: string, root: string): boolean {
  if (a === b) return true;
  return isWindowsLikePath(root) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinPrefix(path: string, prefix: string, root: string): boolean {
  if (samePath(path, prefix, root) && path === prefix) return true;
  if (path.startsWith(`${prefix}/`)) return true;
  if (isWindowsLikePath(prefix) && path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return true;
  return false;
}

interface TabsState {
  activeRuntimeKey: string;
  runtimeSnapshots: Record<string, { byRoot: Record<string, RootTabs>; updatedAt: number }>;
  byRoot: Record<string, RootTabs>;
  setSelectedPath: (root: string, path: string, runtimeKey: string) => void;
  removeOpenPath: (root: string, path: string) => void;
  removeOpenPathsByPrefix: (root: string, prefixPath: string) => void;
  toggleExpandedPath: (root: string, path: string) => void;
  collapseAllExpandedPaths: (root: string) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
  __resetForTests: () => void;
}

export const useFilesViewTabsStore = create<TabsState>((set) => ({
  ...hydrate(),
  setSelectedPath: (root, path, runtimeKey) => set((state) => {
    if (runtimeKey !== state.activeRuntimeKey) {
      getRuntimeSwitched(state, runtimeKey);
      state = useFilesViewTabsStore.getState();
    }
    const doc = rootDoc(state, root);
    const open = appendOpen(doc.openPaths, path);
    const byRoot = capRoots({ ...state.byRoot, [root]: { ...doc, openPaths: open, selectedPath: path, touchedAt: Date.now() } });
    return { byRoot };
  }),
  removeOpenPath: (root, path) => set((state) => {
    const doc = rootDoc(state, root);
    const open = doc.openPaths.filter((entry) => !samePath(entry, path, root));
    const selected = doc.selectedPath !== null && samePath(doc.selectedPath, path, root)
      ? open[0] ?? null
      : doc.selectedPath;
    return { byRoot: capRoots({ ...state.byRoot, [root]: { ...doc, openPaths: open, selectedPath: selected, touchedAt: Date.now() } }) };
  }),
  removeOpenPathsByPrefix: (root, prefixPath) => set((state) => {
    const doc = rootDoc(state, root);
    const open = doc.openPaths.filter((entry) => !isWithinPrefix(entry, prefixPath, root));
    const selected = doc.selectedPath !== null && isWithinPrefix(doc.selectedPath, prefixPath, root)
      ? open[0] ?? null
      : doc.selectedPath;
    const expanded = doc.expandedPaths.filter((entry) => !isWithinPrefix(entry, prefixPath, root));
    return { byRoot: capRoots({ ...state.byRoot, [root]: { ...doc, openPaths: open, selectedPath: selected, expandedPaths: expanded, touchedAt: Date.now() } }) };
  }),
  toggleExpandedPath: (root, path) => set((state) => {
    const doc = rootDoc(state, root);
    const expanded = doc.expandedPaths.includes(path)
      ? doc.expandedPaths.filter((entry) => entry !== path)
      : [...doc.expandedPaths, path].slice(-MAX_EXPANDED_PATHS_PER_ROOT);
    return { byRoot: capRoots({ ...state.byRoot, [root]: { ...doc, expandedPaths: expanded, touchedAt: Date.now() } }) };
  }),
  collapseAllExpandedPaths: (root) => set((state) => {
    const doc = rootDoc(state, root);
    return { byRoot: capRoots({ ...state.byRoot, [root]: { ...doc, expandedPaths: [], touchedAt: Date.now() } }) };
  }),
  resetForRuntimeSwitch: (runtimeKey) => set((state) => {
    getRuntimeSwitched(state, runtimeKey);
    const after = useFilesViewTabsStore.getState();
    return { activeRuntimeKey: after.activeRuntimeKey, runtimeSnapshots: after.runtimeSnapshots, byRoot: after.byRoot };
  }),
  __resetForTests: () => { useFilesViewTabsStore.setState({ activeRuntimeKey: 'url:default', byRoot: {}, runtimeSnapshots: {} }); },
}));

function getRuntimeSwitched(state: TabsState, runtimeKey: string): void {
  const snapshots = { ...state.runtimeSnapshots };
  snapshots[state.activeRuntimeKey] = { byRoot: state.byRoot, updatedAt: Date.now() };
  const keys = Object.keys(snapshots).filter((key) => key !== runtimeKey);
  while (keys.length >= MAX_RUNTIME_SNAPSHOTS) delete snapshots[keys.shift()!];
  const incoming = state.activeRuntimeKey === runtimeKey ? state.byRoot : snapshots[runtimeKey]?.byRoot ?? {};
  const next = { activeRuntimeKey: runtimeKey, runtimeSnapshots: snapshots, byRoot: incoming };
  useFilesViewTabsStore.setState(next);
  localStorageSave({ activeRuntimeKey: next.activeRuntimeKey, runtimeSnapshots: next.runtimeSnapshots });
}

function rootDoc(state: TabsState, root: string): RootTabs {
  return state.byRoot[root] ?? { openPaths: [], selectedPath: null, expandedPaths: [], touchedAt: Date.now() };
}

function capRoots(byRoot: Record<string, RootTabs>): Record<string, RootTabs> {
  const now = Date.now();
  const entries = Object.entries(byRoot)
    .filter(([, doc]) => now - doc.touchedAt < ROOT_TTL_MS)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
    .slice(0, MAX_ROOTS);
  return Object.fromEntries(entries);
}

function appendOpen(openPaths: string[], path: string): string[] {
  if (path.length > MAX_PATH_LENGTH) return openPaths;
  const without = openPaths.filter((entry) => entry !== path);
  const next = [...without, path];
  return next.length > MAX_OPEN_PATHS_PER_ROOT ? next.slice(next.length - MAX_OPEN_PATHS_PER_ROOT) : next;
}

function hydrate(): { activeRuntimeKey: string; runtimeSnapshots: PersistedShape['runtimeSnapshots']; byRoot: Record<string, RootTabs> } {
  const fallback = { activeRuntimeKey: 'url:default', runtimeSnapshots: {} as PersistedShape['runtimeSnapshots'], byRoot: {} as Record<string, RootTabs> };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) { localStorageSave(fallback); return fallback; }
    const parsed = JSON.parse(raw) as { version?: number; activeRuntimeKey?: string; runtimeSnapshots?: PersistedShape['runtimeSnapshots'] };
    if (parsed.version !== STORAGE_VERSION) { localStorageSave(fallback); return fallback; }
    const active = typeof parsed.activeRuntimeKey === 'string' ? parsed.activeRuntimeKey : 'url:default';
    const snapshots = parsed.runtimeSnapshots ?? {};
    return { activeRuntimeKey: active, runtimeSnapshots: snapshots, byRoot: snapshots[active]?.byRoot ?? {} };;
  } catch {
    localStorageSave(fallback);
    return fallback;
  }
}

function localStorageSave(shape: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...shape, version: STORAGE_VERSION }));
  } catch { /* private mode: tabs stay session-only */ }
}

export function effectiveSelectedPath(root: string): string | null {
  const doc = useFilesViewTabsStore.getState().byRoot[root];
  if (!doc) return null;
  if (doc.selectedPath !== null && doc.openPaths.some((entry) => entry === doc.selectedPath)) return doc.selectedPath;
  return doc.openPaths[0] ?? null;
}

// §2.6 persistence contract: the ACTIVE runtime's snapshot always mirrors
// the live map (localStorage write only — no set(), avoiding recursion), so
// a reload restores open tabs even without an explicit runtime switch.
useFilesViewTabsStore.subscribe((state) => {
  const snapshots = { ...state.runtimeSnapshots, [state.activeRuntimeKey]: { byRoot: state.byRoot, updatedAt: Date.now() } };
  localStorageSave({ activeRuntimeKey: state.activeRuntimeKey, runtimeSnapshots: snapshots });
});
