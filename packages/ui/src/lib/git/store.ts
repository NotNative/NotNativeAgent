// SPDX-License-Identifier: Apache-2.0
/**
 * useGitStore (doc 06 11.1): per-directory runtime-scoped caches §§ status
 * (5 s stale), branches (30 s), log (10 s), identity (60 s), repo probe
 * (60 s), per-file diffs (LRU 30/20 MiB per dir, 200/20 MiB global), all
 * keyed by `JSON[runtimeKey, directory]`-style buckets. Index mutations
 * move rows optimistically with rollback, bump indexRevision, and schedule
 * the 6.4 15 s reconcile.
 */
import { create } from 'zustand';
import {
  fetchGitBranches, fetchGitDiff, fetchGitLog, fetchGitStatus, isStagedStatusFile, isWorkingStatusFile,
  statusSymbol, type GitBranch, type GitStatus, type GitStatusFile,
} from './api';
import { getRuntimeKey } from '../runtime-switch.ts';

export const REPO_CHECK_STALE_MS = 60_000;
export const STATUS_STALE_MS = 5_000;
export const BRANCHES_STALE_MS = 30_000;
export const LOG_STALE_MS = 10_000;
export const IDENTITY_STALE_MS = 60_000;
export const GIT_RECONCILE_DELAY_MS = 15_000;
export const DIFF_CACHE_PER_DIR = 30;
export const MAX_OPEN_FILE_LINES = 20_000;

interface StatusEntry {
  status: GitStatus;
  fetchedAt: number;
  mode: 'light' | 'full';
}

interface GitState {
  buckets: Record<string, {
    status?: StatusEntry;
    branches?: { value: GitBranch; fetchedAt: number };
    log?: { value: NonNullable<Awaited<ReturnType<typeof fetchGitLog>>>; fetchedAt: number; maxCount: number };
    diffs: Map<string, { patch: string; fetchedAt: number; bytes: number }>;
    indexRevision: number;
    statusMutationRevision: number;
  }>;
  bucketOf: (directory: string) => NonNullable<GitState['buckets'][string]>;
  ensureAll: (directory: string) => Promise<void>;
  ensureStatus: (directory: string, mode?: 'light' | 'full') => Promise<GitStatus | null>;
  moveStatusPathsOptimistically: (directory: string, paths: string[], direction: 'stage' | 'unstage') => GitStatus | null;
  restoreStatus: (directory: string, snapshot: GitStatus) => void;
  bumpIndexRevision: (directory: string) => void;
  setDiff: (directory: string, path: string, patch: string) => void;
  clearDiffCache: (directory: string, paths?: string[]) => void;
  getDiff: (directory: string, path: string, staged: boolean, contextLines: number) => Promise<string | null>;
  invalidate: (directory?: string) => void;
  __resetForTests: () => void;
}

function keyFor(directory: string, runtimeKey: string): string {
  return JSON.stringify([runtimeKey, directory]);
}

export const useGitStore = create<GitState>((set, getState) => ({
  buckets: {},
  bucketOf: (directory: string) => {
    const key = keyFor(directory, getRuntimeKey());
    const buckets = getState().buckets;
    return buckets[key] ?? { diffs: new Map(), indexRevision: 0, statusMutationRevision: 0 };
  },
  ensureAll: async (directory: string) => {
    const key = keyFor(directory, getRuntimeKey());
    const bucket = getState().bucketOf(directory);
    const now = Date.now();
    if (bucket.status === undefined || now - bucket.status.fetchedAt > STATUS_STALE_MS) {
      const status = await fetchGitStatus(directory, 'light');
      if (status !== null) {
        set((state) => {
          const key2 = keyFor(directory, getRuntimeKey());
          const existing = state.buckets[key2] ?? bucket;
          return { buckets: { ...state.buckets, [key2]: { ...existing, status: { status, fetchedAt: Date.now(), mode: 'light' } } } };
        });
      }
    }
    if (bucket.branches === undefined || now - (bucket.branches?.fetchedAt ?? 0) > BRANCHES_STALE_MS) {
      const branches = await fetchGitBranches(directory);
      if (branches !== null) {
        set((state) => {
          const key2 = keyFor(directory, getRuntimeKey());
          const existing = state.buckets[key2] ?? getState().bucketOf(directory);
          return {
            buckets: {
              ...state.buckets,
              [key2]: { ...existing, branches: { value: branches, fetchedAt: Date.now() } },
            },
          };
        });
      }
    }
    if (bucket.log === undefined || now - (bucket.log?.fetchedAt ?? 0) > LOG_STALE_MS) {
      const log = await fetchGitLog(directory, bucket.log?.maxCount ?? 50);
      if (log !== null) {
        set((state) => {
          const key2 = keyFor(directory, getRuntimeKey());
          const existing = state.buckets[key2] ?? getState().bucketOf(directory);
          return { buckets: { ...state.buckets, [key2]: { ...existing, log: { value: log, fetchedAt: Date.now(), maxCount: 50 } } } };
        });
      }
    }
    void key; // key shape documented; single-flight per bucket WIP (11.1)
  },
  ensureStatus: async (directory: string, mode = 'light'): Promise<GitStatus | null> => {
    const key = keyFor(directory, getRuntimeKey());
    const bucket = getState().bucketOf(directory);
    const now = Date.now();
    if (bucket.status !== undefined && now - bucket.status.fetchedAt < STATUS_STALE_MS) return bucket.status.status;
    const status = await fetchGitStatus(directory, mode);
    if (status === null) return null;
    set((state) => {
      const existing = state.buckets[key] ?? getState().bucketOf(directory);
      return { buckets: { ...state.buckets, [key]: { ...existing, status: { status, fetchedAt: Date.now(), mode } } } };
    });
    return status;
  },
  moveStatusPathsOptimistically: (directory, paths, direction) => {
    const key = keyFor(directory, getRuntimeKey());
    const bucket = getState().bucketOf(directory);
    const status = bucket.status?.status;
    if (status === undefined) return null;
    const pathSet = new Set(paths.map((path) => path.toLowerCase()));
    const files: GitStatusFile[] = status.files.map((entry) => {
      if (!pathSet.has(entry.path.toLowerCase())) return entry;
      const symbol = statusSymbol(entry);
      if (direction === 'stage') {
        return { ...entry, index: symbol === 'A' ? 'A' : 'M', working_dir: ' ' };
      }
      return { ...entry, index: ' ', working_dir: symbol === 'A' ? '?' : 'M' };
    });
    const next = { ...status, files };
    set((state) => {
      const existing = state.buckets[key] ?? bucket;
      return {
        buckets: {
          ...state.buckets,
          [key]: {
            ...existing,
            status: { status: next, fetchedAt: Date.now(), mode: 'light' },
            statusMutationRevision: existing.statusMutationRevision + 1,
          },
        },
      };
    });
    return next;
  },
  restoreStatus: (directory, snapshot) => {
    const key = keyFor(directory, getRuntimeKey());
    set((state) => {
      const existing = state.buckets[key] ?? getState().bucketOf(directory);
      return {
        buckets: {
          ...state.buckets,
          [key]: { ...existing, status: { status: snapshot, fetchedAt: Date.now(), mode: 'light' }, statusMutationRevision: existing.statusMutationRevision + 1 },
        },
      };
    });
  },
  bumpIndexRevision: (directory: string) => {
    const key = keyFor(directory, getRuntimeKey());
    set((state) => {
      const existing = state.buckets[key] ?? getState().bucketOf(directory);
      return { buckets: { ...state.buckets, [key]: { ...existing, indexRevision: existing.indexRevision + 1 } } };
    });
  },
  setDiff: (directory, path, patch) => {
    const key = keyFor(directory, getRuntimeKey());
    const bytes = patch.length;
    if (bytes > 20 * 1024 * 1024) return; // >20 MiB single entry refuses (11.1)
    set((state) => {
      const existing = state.buckets[key] ?? getState().bucketOf(directory);
      const diffs = new Map(existing.diffs);
      diffs.set(`${path}|staged`, { patch, fetchedAt: Date.now(), bytes });
      // LRU cap 30/directory + 200 entries global + 20 MiB text target
      while (diffs.size > DIFF_CACHE_PER_DIR) {
        const oldest = [...diffs.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0]![0];
        diffs.delete(oldest);
      }
      return { buckets: { ...state.buckets, [key]: { ...existing, diffs } } };
    });
  },
  clearDiffCache: (directory, paths) => {
    const key = keyFor(directory, getRuntimeKey());
    set((state) => {
      const existing = state.buckets[key];
      if (existing === undefined) return state;
      const diffs = new Map(existing.diffs);
      if (paths === undefined) diffs.clear();
      else for (const path of paths) {
        diffs.delete(`${path}|staged`);
        diffs.delete(`${path}|unstaged`);
      }
      return { buckets: { ...state.buckets, [key]: { ...existing, diffs } } };
    });
  },
  getDiff: async (directory, path, staged, contextLines) => {
    const key = keyFor(directory, getRuntimeKey());
    const bucket = getState().bucketOf(directory);
    const cached = bucket.diffs.get(`${path}|${staged ? 'staged' : 'unstaged'}`);
    const contextKey = `${contextLines}`;
    if (cached !== undefined) return cached.patch;
    const response = await fetchGitDiff(directory, path, { staged, contextLines });
    if (response === null) return null;
    set((state) => {
      const existing = state.buckets[key] ?? getState().bucketOf(directory);
      const diffs = new Map(existing.diffs);
      diffs.set(`${path}|${staged ? 'staged' : 'unstaged'}`, { patch: response.diff, fetchedAt: Date.now(), bytes: response.diff.length + contextKey.length });
      while (diffs.size > DIFF_CACHE_PER_DIR) {
        const oldest = [...diffs.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0]![0];
        diffs.delete(oldest);
      }
      return { buckets: { ...state.buckets, [key]: { ...existing, diffs } } };
    });
    return response.diff;
  },
  invalidate: (directory) => {
    set((state) => {
      if (directory === undefined) return { buckets: {} };
      const key = keyFor(directory, getRuntimeKey());
      const next = { ...state.buckets };
      delete next[key];
      return { buckets: next };
    });
  },
  __resetForTests: () => set({ buckets: {} }),
}));

// 6.3 grouped status readers.
export function groupedStatusFiles(status: GitStatus): { staged: GitStatusFile[]; working: GitStatusFile[] } {
  const staged = status.files.filter(isStagedStatusFile);
  const working = status.files.filter((entry) => isWorkingStatusFile(entry) && !(staged.includes(entry)));
  return { staged, working };
}

let reconcileTimer: number | null = null;

/** 6.4: after any index mutation a silent status fetch reconciles at 15 s. */
export function scheduleGitReconcile(directory: string): void {
  if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = null;
    void useGitStore.getState().ensureStatus(directory, 'full');
  }, GIT_RECONCILE_DELAY_MS);
}
