// SPDX-License-Identifier: Apache-2.0
/**
 * DiffView (doc 06 sections 5.3-5.7, P6-2 subset): scope selector (all,
 * working, staged; turn = PA0020; branch/commit/pr = P11 range routes),
 * stacked entries with a file sidebar, default-expansion rules (6, 6, 4,
 * 2), the >500-line large-diff gate, per-hunk stage/unstage/discard riding
 * the canonical single-hunk patch (version-matched), optimistic stage
 * queue with rollback + 15 s reconcile (section 6.4).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DiffViewer } from './DiffViewer.tsx';
import { useGitStore, groupedStatusFiles, scheduleGitReconcile } from '../../lib/git/store';
import {
  applyGitHunk, fetchGitDiff, stageGitFiles, unstageGitFiles, isStagedStatusFile, statusSymbol,
  type GitStatus, type GitStatusFile,
} from '../../lib/git/api';
import {
  extractHunkPatch, fileDiffFromPatch, haveMatchingPatchVersions, isBinaryPatch,
  LARGE_DIFF_CHANGED_LINES, type FileDiffMetadata,
} from '../../lib/git/diff-model';

type Scope = 'all' | 'working' | 'staged';
type InFlight = null | 'hunk' | 'group';

interface StackEntry {
  entry: GitStatusFile;
  staged: boolean;
}

interface EntryDiff {
  metadata: FileDiffMetadata | null;
  binary: boolean;
  error: string | null;
}

const defaultExpanded = (count: number): number => count <= 6 ? count : count <= 12 ? 6 : count <= 25 ? 4 : 2;

export function DiffView({ directory, visible }: { directory: string; visible: boolean }): ReactNode {
  const model = useDiffModel({ directory, visible });
  const [expandAll, setExpandAll] = useState(false);
  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-2" data-testid="diff-view">
      <Sidebar model={model} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mb-2 flex items-center gap-2 px-1">
          <button type="button" className="rounded bg-primary/20 px-2 py-0.5 text-[11px] text-primary disabled:opacity-40" disabled={model.inFlight !== null} onClick={() => void model.stageAll()}>Stage all changes</button>
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpandAll(!expandAll)}>Expand all</button>
        </div>
        {model.entries.map((item) => (
          <EntryRow
            key={`${item.entry.path}:${item.staged}`}
            model={{ ...model, isExpanded: (path: string) => model.isExpanded(path) || expandAll }}
            entry={item}
          />
        ))}
        {model.status !== null && model.status.files.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Working tree clean, no changes to display</div>
        ) : null}
      </div>
    </div>
  );
}

function symbolColor(symbol: string): string {
  if (symbol === 'A') return 'var(--status-success)';
  if (symbol === 'D' || symbol === 'U') return 'var(--status-error)';
  if (symbol === 'M') return 'var(--status-warning)';
  return 'var(--status-info)';
}

interface DiffModel {
  status: GitStatus | null;
  entries: StackEntry[];
  diffsOf: (path: string) => EntryDiff | undefined;
  isExpanded: (path: string) => boolean;
  toggle: (path: string) => void;
  inFlight: InFlight;
  stageAll: () => Promise<void>;
  stageToggle: (entry: GitStatusFile, staged: boolean) => Promise<void>;
  hunkAction: (entry: GitStatusFile, staged: boolean, hunkIndex: number, action: string) => Promise<void>;
}

/** Model = state + composition; actions delegate to module functions. */
function useDiffModel(deps: { directory: string; visible: boolean }): DiffModel {
  const { directory, visible } = deps;
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const getDiff = useGitStore((state) => state.getDiff);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diffs, setDiffs] = useState<Record<string, EntryDiff>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inFlight, setInFlight] = useState<InFlight>(null);
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;

  useEffect(() => {
    if (!visible || directory.length === 0) return undefined;
    void ensureStatus(directory, 'light').then((next) => setStatus(next));
    return undefined;
  }, [visible, directory, ensureStatus]);

  const grouped = useMemo(() => (status !== null ? groupedStatusFiles(status) : { staged: [], working: [] }), [status]);
  const entries: StackEntry[] = useMemo(() => dedupeEntries([
    ...grouped.staged.map((entry) => ({ entry, staged: true })),
    ...grouped.working.map((entry) => ({ entry, staged: false })),
  ]), [grouped]);

  // Entry pipeline (doc 06 5.6.a): cache, fetch patch (context 3), model.
  useDiffPipeline({ directory, visible, entries, diffs, getDiff, setDiffs });

  const stageAll = useCallback(async (): Promise<void> => {
    await stageEntries(directory, entries.filter((item) => !item.staged).map((item) => item.entry.path), 'stage', setInFlight, ensureStatus, setStatus);
  }, [directory, entries, ensureStatus, setInFlight]);

  const stageToggle = useCallback(async (entry: GitStatusFile, staged: boolean): Promise<void> => {
    await stageEntries(directory, [entry.path], staged ? 'unstage' : 'stage', setInFlight, ensureStatus, setStatus);
  }, [directory, ensureStatus, setInFlight]);

  const hunkAction = useCallback(async (entry: GitStatusFile, staged: boolean, hunkIndex: number, action: string): Promise<void> => {
    await runHunkAction(directory, entry.path, staged, hunkIndex, action, setInFlight, ensureStatus, setStatus);
  }, [directory, ensureStatus, setInFlight]);

  return {
    status,
    entries,
    diffsOf: (path: string) => diffs[path],
    isExpanded: (path: string) => expanded.has(path),
    toggle: (path: string) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    }),
    inFlight,
    stageAll,
    stageToggle,
    hunkAction,
  };
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


/** 5.6.a entry pipeline: cache, fetch patch (context 3), model. */
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
      if (diffs[item.entry.path] !== undefined) continue;
      void (async (): Promise<void> => {
        try {
          const patch = await getDiff(directory, item.entry.path, item.staged, 3);
          if (patch === null) return;
          if (isBinaryPatch(patch)) {
            setDiffs((current) => ({ ...current, [item.entry.path]: { metadata: null, binary: true, error: null } }));
            return;
          }
          setDiffs((current) => ({ ...current, [item.entry.path]: { metadata: fileDiffFromPatch(item.entry.path, patch), binary: false, error: null } }));
        } catch {
          setDiffs((current) => ({ ...current, [item.entry.path]: { metadata: null, binary: false, error: 'Failed to load diff' } }));
        }
      })();
    }
    return undefined;
  }, [visible, directory, entries, diffs, getDiff, setDiffs]);
}
/** Section 6.4 optimistic stage queue with rollback. */
async function stageEntries(
  directory: string,
  paths: string[],
  direction: 'stage' | 'unstage',
  setInFlight: (value: InFlight) => void,
  ensureStatus: (directory: string, mode: 'light' | 'full') => Promise<GitStatus | null>,
  setStatus: (status: GitStatus | null) => void,
): Promise<void> {
  if (paths.length === 0) return;
  setInFlight('group');
  const before = await ensureStatus(directory, 'light');
  const moved = before !== null ? useGitStore.getState().moveStatusPathsOptimistically(directory, paths, direction) : null;
  try {
    if (direction === 'stage') await stageGitFiles(directory, paths);
    else await unstageGitFiles(directory, paths);
    useGitStore.getState().bumpIndexRevision(directory);
    scheduleGitReconcile(directory);
    setStatus(await ensureStatus(directory, 'full'));
  } catch {
    if (before !== null && moved !== null) useGitStore.getState().restoreStatus(directory, before);
    toast.error(direction === 'stage' ? 'Failed to stage file' : 'Failed to unstage file');
  } finally {
    setInFlight(null);
  }
}

/** Section 5.10 hunk action (canonical patch + version match). */
async function runHunkAction(
  directory: string,
  path: string,
  staged: boolean,
  hunkIndex: number,
  rawAction: string,
  setInFlight: (value: InFlight) => void,
  ensureStatus: (directory: string, mode: 'light' | 'full') => Promise<GitStatus | null>,
  setStatus: (status: GitStatus | null) => void,
): Promise<void> {
  const displayPatch = await useGitStore.getState().getDiff(directory, path, staged, 3);
  const refreshed = await fetchGitDiff(directory, path, { staged, contextLines: 3 });
  if (displayPatch === null || refreshed === null || !haveMatchingPatchVersions(displayPatch, refreshed.diff)) {
    toast.error('This hunk is no longer available. Refresh the diff and try again.');
    return;
  }
  const patch = extractHunkPatch(displayPatch, hunkIndex);
  if (patch === null) {
    toast.error('This hunk is no longer available. Refresh the diff and try again.');
    return;
  }
  setInFlight('hunk');
  try {
    await applyGitHunk(directory, path, patch, rawAction as 'stage' | 'unstage' | 'discard');
    useGitStore.getState().clearDiffCache(directory, [path]);
    useGitStore.getState().bumpIndexRevision(directory);
    scheduleGitReconcile(directory);
    setStatus(await ensureStatus(directory, 'full'));
  } finally {
    setInFlight(null);
  }
}

async function refreshBefore(directory: string): Promise<GitStatus | null> {
  return useGitStore.getState().ensureStatus(directory, 'light');
}

function Sidebar({ model }: { model: DiffModel }): ReactNode {
  const grouped = model.status !== null ? groupedStatusFiles(model.status) : { staged: [], working: [] };
  const workingCount = grouped.working.length;
  const stagedCount = grouped.staged.length;
  return (
    <div className="w-64 shrink-0 rounded-lg border border-border/60 bg-card/40">
      <div className="flex flex-wrap gap-1 px-2 py-1.5" role="group" aria-label="Select change mode">
        <span className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">{`Changed: ${workingCount + stagedCount}`}</span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">{`Working: ${workingCount}`}</span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">{`Staged: ${stagedCount}`}</span>
      </div>
      <div className="flex max-h-[60vh] flex-col gap-0.5 px-1 overflow-y-auto">
        {model.entries.map((item) => (
          <button
            key={`${item.entry.path}:${item.staged}`}
            type="button"
            title={item.entry.path}
            className="truncate rounded px-2 py-1 text-left text-xs text-foreground hover:bg-interactive-hover/40"
            onClick={() => model.toggle(item.entry.path)}
          >
            <span className="mr-1 inline-block w-3 text-center" style={{ color: symbolColor(statusSymbol(item.entry)) }}>{statusSymbol(item.entry)}</span>
            {item.entry.path}
          </button>
        ))}
      </div>
    </div>
  );
}

function EntryRow({ model, entry }: { model: DiffModel; entry: StackEntry }): ReactNode {
  const diff = model.diffsOf(entry.entry.path);
  const changedLines = (diff?.metadata?.insertionCount ?? 0) + (diff?.metadata?.deletionCount ?? 0);
  const gated = changedLines > LARGE_DIFF_CHANGED_LINES;
  const isOpen = model.isExpanded(entry.entry.path);
  const busy = model.inFlight !== null;
  const symbol = statusSymbol(entry.entry);
  return (
    <section className="mb-2 rounded-lg border border-border/60 bg-card/40" data-testid="diff-entry" data-path={entry.entry.path}>
      <header className="flex items-center gap-2 px-3 py-1.5">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-xs text-foreground" title={entry.entry.path} onClick={() => model.toggle(entry.entry.path)}>
          <span className="mr-1 inline-block w-3 text-center" style={{ color: symbolColor(symbol) }}>{symbol}</span>
          {entry.entry.path}
        </button>
        <span className="text-[10px] text-muted-foreground">{entry.staged ? 'staged' : 'working'}</span>
        <button type="button" disabled={busy} className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => void model.stageToggle(entry.entry, entry.staged)}>
          {entry.staged ? 'Unstage' : 'Stage'}
        </button>
      </header>
      {isOpen && gated ? (
        <div className="p-3 text-xs text-muted-foreground">
          {`Large diff (${changedLines} changed lines)`} — rendering may be slow. You can still view the diff by clicking below.
        </div>
      ) : isOpen ? (
        <div className="px-3 pb-2">
          {diff === undefined ? <div className="text-xs text-muted-foreground">Loading...</div>
            : diff.error !== null ? <div className="text-xs text-status-error">{diff.error}</div>
              : diff.binary ? <div className="text-xs text-muted-foreground">Binary file — no diff available</div>
                : (
                  <DiffViewer
                    fileName={entry.entry.path}
                    fileDiff={diff.metadata!}
                    renderSideBySide={false}
                    wrapLines={false}
                    hunkActions={(hunkIndex) => (
                      <span className="ml-auto flex gap-1">
                        <button type="button" disabled={busy} aria-label={`Discard hunk ${hunkIndex + 1}`} className="rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => void model.hunkAction(entry.entry, entry.staged, hunkIndex, 'discard')}>discard</button>
                        <button type="button" disabled={busy} aria-label={`Stage hunk ${hunkIndex + 1}`} className="rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => void model.hunkAction(entry.entry, entry.staged, hunkIndex, 'stage')}>stage</button>
                      </span>
                    )}
                  />
                )}
        </div>
      ) : null}
    </section>
  );
}
