// SPDX-License-Identifier: Apache-2.0
/**
 * DiffView model (doc 06 §5.3–§5.8, §11.3, P6-2 v1 + SLICE-B): the headless
 * half of the diff band — per-scope stacked entry keying (`path|staged`),
 * §5.4 default expansion (6/6/4/2), §6.3 15 s status cadence, §13#1 buffered
 * hint replay (store cache + local diffs dropped, restat), the §5.6.a per-
 * entry patch pipeline (context 3, binary bail), the §6.4 optimistic stage
 * queue with rollback, and the §5.6.d version-matched single-hunk action.
 * The JSX halves live in components/diff/DiffView.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useGitStore, groupedStatusFiles, scheduleGitReconcile } from '../../lib/git/store';
import {
  applyGitHunk, fetchGitDiff, stageGitFiles, unstageGitFiles,
  statusSymbol, type GitStatus, type GitStatusFile,
} from '../../lib/git/api';
import { publishReviewRefresh } from '../../lib/git/refresh-hints';
import { useReviewRefreshHints, type ReviewRefreshHint } from '../../lib/git/refresh-hints';
import {
  extractHunkPatch, fileDiffFromPatch, haveMatchingPatchVersions, isBinaryPatch,
  LARGE_DIFF_CHANGED_LINES, type FileDiffMetadata,
} from '../../lib/git/diff-model';
import { GIT_STATUS_POLL_INTERVAL_MS } from '../../lib/files/edit-support.ts';
import { useI18n } from '../../lib/i18n/context.tsx';

export type Scope = 'all' | 'working' | 'staged';
export type InFlight = null | 'hunk' | 'group';

export interface StackEntry {
  entry: GitStatusFile;
  staged: boolean;
}

export interface EntryDiff {
  metadata: FileDiffMetadata | null;
  binary: boolean;
  error: 'failed' | 'unavailable' | null;
}

export type RefBox<T> = { current: T | null };

export const diffKeyOf = (path: string, staged: boolean): string => `${path}|${staged ? 'staged' : 'unstaged'}`;
/** §5.4 stacked default expansion: 6 → all, 12 → 6, 25 → 4, else 2. */
export const defaultExpanded = (count: number): number => count <= 6 ? count : count <= 12 ? 6 : count <= 25 ? 4 : 2;

export const LARGE_DIFF_GATE = LARGE_DIFF_CHANGED_LINES;
export function statusSymbolOf(entry: GitStatusFile): string { return statusSymbol(entry); }

export interface DiffModel {
  scope: Scope;
  status: GitStatus | null;
  entries: StackEntry[];
  counts: { working: number; staged: number; total: number };
  diffsOf: (path: string, staged: boolean) => EntryDiff | undefined;
  renderAnywayOf: (path: string, staged: boolean) => boolean;
  isExpanded: (path: string) => boolean;
  toggle: (path: string) => void;
  setScope: (scope: Scope) => void;
  renderAnyway: (path: string, staged: boolean) => void;
  inFlight: InFlight;
  stageAll: () => Promise<void>;
  stageToggle: (entry: GitStatusFile, staged: boolean) => Promise<void>;
  hunkAction: (entry: GitStatusFile, staged: boolean, hunkIndex: number, action: string) => Promise<void>;
}

export interface DiffModelDeps {
  directory: string;
  visible: boolean;
}

/** Model = state + composition; actions delegate to module functions. */
export function useDiffModel(deps: DiffModelDeps): DiffModel {
  const { t } = useI18n();
  const { directory, visible } = deps;
  const getDiff = useGitStore((state) => state.getDiff);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [diffs, setDiffs] = useState<Record<string, EntryDiff>>({});
  const [expandAnyway, setExpandAnyway] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inFlight, setInFlight] = useState<InFlight>(null);

  const refreshStatus = useCallback((): void => {
    useGitStore.getState().invalidateStatus(directory);
    void useGitStore.getState().ensureStatus(directory, 'light')
      .then((next) => setStatus(next))
      .catch(() => undefined);
  }, [directory]);

  // §13#1 + §11.3: hint replay wipes the touched scopes locally before the restat.
  const clearHintedDiffs = useCallback((paths: string[] | null): void => {
    useGitStore.getState().clearDiffCache(directory, paths === null ? undefined : paths);
    setDiffs((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        const [path] = key.split('|');
        if (paths === null || (path !== undefined && paths.includes(path))) delete next[key];
      }
      return next;
    });
  }, [directory]);

  useDiffStatusFeed({ directory, visible, setStatus, refreshStatus, clearHintedDiffs });

  const { entries, counts } = useDiffPieces(status, scope, setExpanded);

  // Entry pipeline (§5.6.a): fetch patch (context 3) + model, per scope key.
  useDiffPipeline({ directory, visible, entries, diffs, getDiff, setDiffs });

  const actions = useDiffActions({
    directory,
    entries,
    setInFlight,
    setStatus,
    wipeHinted: clearHintedDiffs,
    messages: {
      stageFailed: t('gitUi.stageFailed'),
      unstageFailed: t('gitUi.unstageFailed'),
      hunkUnavailable: t('diffUi.hunkUnavailable'),
      hunkFailed: t('diffUi.hunkFailed'),
    },
  });

  return {
    scope,
    status,
    entries,
    counts,
    diffsOf: (path: string, staged: boolean) => diffs[diffKeyOf(path, staged)],
    renderAnywayOf: (path: string, staged: boolean) => expandAnyway.has(diffKeyOf(path, staged)),
    isExpanded: (path: string) => expanded.has(path),
    toggle: (path: string) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    }),
    setScope,
    renderAnyway: (path: string, staged: boolean) => setExpandAnyway((current) => new Set(current).add(diffKeyOf(path, staged))),
    inFlight,
    stageAll: actions.stageAll,
    stageToggle: actions.stageToggle,
    hunkAction: actions.hunkAction,
  };
}

/** Stacked entries + counts + the §5.4 first-paint expansion (6/6/4/2). */
function useDiffPieces(
  status: GitStatus | null,
  scope: Scope,
  setExpanded: (update: (current: Set<string>) => Set<string>) => void,
): { entries: StackEntry[]; counts: { working: number; staged: number; total: number } } {
  const grouped = useMemo(() => (status !== null ? groupedStatusFiles(status) : { staged: [], working: [] }), [status]);
  const allEntries: StackEntry[] = useMemo(() => dedupeEntries([
    ...grouped.staged.map((entry) => ({ entry, staged: true })),
    ...grouped.working.map((entry) => ({ entry, staged: false })),
  ]), [grouped]);
  const entries = useMemo(() => filterByScope(allEntries, scope), [allEntries, scope]);
  const counts = useMemo(() => ({
    working: grouped.working.length,
    staged: grouped.staged.length,
    total: new Set(allEntries.map((item) => item.entry.path)).size,
  }), [allEntries, grouped]);

  // §5.4 default expansion (6/6/4/2 by entry count) — first paint only.
  useEffect(() => {
    if (entries.length === 0) return;
    setExpanded((current) => {
      if (current.size > 0) return current;
      const slice = entries.slice(0, defaultExpanded(entries.length));
      return new Set(slice.map((item) => item.entry.path));
    });
  }, [entries, setExpanded]);

  return { entries, counts };
}

/** Status feed half: initial light fetch + the §6.3 15 s cadence + the
 * §13#1 hint subscription (wipes + restat). Owns NO state: publishes upward. */
function useDiffStatusFeed(deps: {
  directory: string;
  visible: boolean;
  setStatus: (status: GitStatus | null) => void;
  refreshStatus: () => void;
  clearHintedDiffs: (paths: string[] | null) => void;
}): void {
  const { directory, visible, setStatus, refreshStatus, clearHintedDiffs } = deps;
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  useEffect(() => {
    if (!visible || directory.length === 0) return undefined;
    void ensureStatus(directory, 'light')
      .then((next) => setStatus(next))
      .catch(() => undefined);
    return undefined;
  }, [visible, directory, ensureStatus, setStatus]);

  // §6.3 cadence: refresh the status every 15 s while the view is live.
  useEffect(() => {
    if (!visible || directory.length === 0) return undefined;
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      void ensureStatus(directory, 'light')
        .then((next) => setStatus(next))
        .catch(() => undefined);
    }, GIT_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(poll);
  }, [visible, directory, ensureStatus, setStatus]);

  // §13#1 buffered hint replay: wipe the hinted scopes local + store, restat.
  useReviewRefreshHints(directory, visible, (hint: ReviewRefreshHint): void => {
    clearHintedDiffs(hint.paths);
    refreshStatus();
  });
}

/** Actions half: optimistic stage queue + hunk apply (module functions). */
function useDiffActions(deps: {
  directory: string;
  entries: StackEntry[];
  setInFlight: (value: InFlight) => void;
  setStatus: (status: GitStatus | null) => void;
  wipeHinted: (paths: string[] | null) => void;
  messages: { stageFailed: string; unstageFailed: string; hunkUnavailable: string; hunkFailed: string };
}): { stageAll: () => Promise<void>; stageToggle: (entry: GitStatusFile, staged: boolean) => Promise<void>; hunkAction: (entry: GitStatusFile, staged: boolean, hunkIndex: number, action: string) => Promise<void> } {
  const { directory, entries, setInFlight, setStatus, wipeHinted, messages } = deps;

  const stageAll = useCallback(async (): Promise<void> => {
    const working = entries.filter((item) => !item.staged).map((item) => item.entry.path);
    await stageEntries(directory, working, 'stage', setInFlight, setStatus, (touched) => wipeHinted(touched), messages.stageFailed);
  }, [directory, entries, setInFlight, setStatus, wipeHinted, messages.stageFailed]);

  const stageToggle = useCallback(async (entry: GitStatusFile, staged: boolean): Promise<void> => {
    await stageEntries(directory, [entry.path], staged ? 'unstage' : 'stage', setInFlight, setStatus, (touched) => wipeHinted(touched), messages.stageFailed, messages.unstageFailed);
  }, [directory, setInFlight, setStatus, wipeHinted, messages.stageFailed, messages.unstageFailed]);

  const hunkAction = useCallback(async (entry: GitStatusFile, staged: boolean, hunkIndex: number, action: string): Promise<void> => {
    await runHunkAction(directory, entry.path, staged, hunkIndex, action, setInFlight, setStatus, (touched) => wipeHinted(touched), messages.hunkUnavailable, messages.hunkFailed);
  }, [directory, setInFlight, setStatus, wipeHinted, messages.hunkUnavailable, messages.hunkFailed]);

  return { stageAll, stageToggle, hunkAction };
}

function filterByScope(entries: StackEntry[], scope: Scope): StackEntry[] {
  if (scope === 'working') return entries.filter((item) => !item.staged);
  if (scope === 'staged') return entries.filter((item) => item.staged);
  return entries;
}

function dedupeEntries(merged: StackEntry[]): StackEntry[] {
  const seen = new Set<string>();
  const out: StackEntry[] = [];
  for (const item of merged) {
    const id = `${item.entry.path}|${item.staged}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** §5.6.a entry pipeline: cache, fetch patch (context 3), model. */
function useDiffPipeline(deps: {
  directory: string;
  visible: boolean;
  entries: StackEntry[];
  diffs: Record<string, EntryDiff>;
  getDiff: (directory: string, path: string, staged: boolean, contextLines: number) => Promise<string | null>;
  setDiffs: (update: (current: Record<string, EntryDiff>) => Record<string, EntryDiff>) => void;
}): void {
  const { directory, visible, entries, diffs, getDiff, setDiffs } = deps;
  useEffect(() => {
    if (!visible) return undefined;
    for (const item of entries) {
      const key = diffKeyOf(item.entry.path, item.staged);
      const current = diffs[key];
      if (current !== undefined && (current.metadata !== null || current.error !== null || current.binary)) continue;
      void (async (): Promise<void> => {
        try {
          const patch = await getDiff(directory, item.entry.path, item.staged, 3);
          if (patch === null) {
            setDiffs((record) => ({ ...record, [key]: { metadata: null, binary: false, error: 'failed' } }));
            return;
          }
          if (isBinaryPatch(patch)) {
            setDiffs((record) => ({ ...record, [key]: { metadata: null, binary: true, error: null } }));
            return;
          }
          setDiffs((record) => ({ ...record, [key]: { metadata: fileDiffFromPatch(item.entry.path, patch), binary: false, error: null } }));
        } catch {
          setDiffs((record) => ({ ...record, [key]: { metadata: null, binary: false, error: 'failed' } }));
        }
      })();
    }
    return undefined;
  }, [visible, directory, entries, diffs, getDiff, setDiffs]);
}

/** §6.4 optimistic stage queue with rollback. */
async function stageEntries(
  directory: string,
  paths: string[],
  direction: 'stage' | 'unstage',
  setInFlight: (value: InFlight) => void,
  setStatus: (status: GitStatus | null) => void,
  wipe?: (touchedPaths: string[]) => void,
  stageFailed = 'Failed to stage file',
  unstageFailed = 'Failed to unstage file',
): Promise<void> {
  if (paths.length === 0) return;
  setInFlight('group');
  let before: GitStatus | null = null;
  let moved: GitStatus | null = null;
  try {
    before = await useGitStore.getState().ensureStatus(directory, 'light');
    moved = before !== null ? useGitStore.getState().moveStatusPathsOptimistically(directory, paths, direction) : null;
    if (direction === 'stage') await stageGitFiles(directory, paths);
    else await unstageGitFiles(directory, paths);
    useGitStore.getState().bumpIndexRevision(directory);
    if (wipe !== undefined) wipe(paths);
    scheduleGitReconcile(directory);
    setStatus(await useGitStore.getState().ensureStatus(directory, 'full'));
    publishReviewRefresh(directory, paths, 'git-mutation');
  } catch {
    if (before !== null && moved !== null) useGitStore.getState().restoreStatus(directory, before);
    toast.error(direction === 'stage' ? stageFailed : unstageFailed);
  } finally {
    setInFlight(null);
  }
}

/** §5.6.d hunk action (canonical patch + version match). */
async function runHunkAction(
  directory: string,
  path: string,
  staged: boolean,
  hunkIndex: number,
  rawAction: string,
  setInFlight: (value: InFlight) => void,
  setStatus: (status: GitStatus | null) => void,
  wipe?: (touchedPaths: string[]) => void,
  hunkUnavailable = 'This hunk is no longer available. Refresh the diff band and try again.',
  hunkFailed = 'Git operation failed',
): Promise<void> {
  setInFlight('hunk');
  try {
    const displayPatch = await useGitStore.getState().getDiff(directory, path, staged, 3);
    const refreshed = await fetchGitDiff(directory, path, { staged, contextLines: 3 });
    if (displayPatch === null || refreshed === null || !haveMatchingPatchVersions(displayPatch, refreshed.diff)) {
      toast.error(hunkUnavailable);
      return;
    }
    const patch = extractHunkPatch(displayPatch, hunkIndex);
    if (patch === null) {
      toast.error(hunkUnavailable);
      return;
    }
    await applyGitHunk(directory, path, patch, rawAction as 'stage' | 'unstage' | 'discard');
    useGitStore.getState().clearDiffCache(directory, [path]);
    useGitStore.getState().bumpIndexRevision(directory);
    if (wipe !== undefined) wipe([path]);
    scheduleGitReconcile(directory);
    setStatus(await useGitStore.getState().ensureStatus(directory, 'full'));
    publishReviewRefresh(directory, [path], 'git-mutation');
  } catch {
    toast.error(hunkFailed);
  } finally {
    setInFlight(null);
  }
}
