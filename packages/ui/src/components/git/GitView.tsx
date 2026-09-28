// SPDX-License-Identifier: Apache-2.0
/**
 * GitView (doc 06 §6, P6-2 v1 + SLICE-B): repository workbench with
 * `visible` gating retained by the shell — full sweep on reveal, 15 s
 * light-status reconcile cadence (§6.4), optimistic stage/unstage/discard
 * with rollback, Commit/Commit & sync, branch info + clean empty state, and
 * the §6.8 READ-ONLY History/Branches dialogs. Mutations publish §13#1
 * refresh hints (paths) so the diff/tree surfaces refresh from one signal.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useGitStore, groupedStatusFiles, scheduleGitReconcile } from '../../lib/git/store';
import {
  commitChanges, discardGitFiles, fetchGitBranches, fetchGitStatus, stageGitFiles, unstageGitFiles,
  statusSymbol, type GitStatus, type GitStatusFile,
} from '../../lib/git/api';
import { publishReviewRefresh, useReviewRefreshHints } from '../../lib/git/refresh-hints';
import { GIT_STATUS_POLL_INTERVAL_MS } from '../../lib/files/edit-support.ts';
import { useCommitDraftStore } from '../../lib/git/commit-drafts.ts';
import { GitDialogHost, type GitDialogKind } from './git-dialogs.tsx';
import { GitFilePreview } from './git-file-preview.tsx';

type SelectedFile = { directory: string; path: string; staged: boolean };
type ReviewRequest = { directory: string; path: string; id: number } | null;

export function GitView({ directory, visible = true, compact = false, reviewRequest = null, onOpenWalkthrough, draftScope }: {
  directory: string; visible?: boolean; compact?: boolean; reviewRequest?: ReviewRequest; onOpenWalkthrough?: () => void; draftScope?: string;
}): ReactNode {
  const [statusSnapshot, setStatusSnapshot] = useState<{ directory: string; value: GitStatus } | null>(null);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  const status = statusSnapshot?.directory === directory ? statusSnapshot.value : null;
  const setStatus = useCallback((targetDirectory: string, next: GitStatus | null): void => {
    if (next !== null && currentDirectory.current === targetDirectory) {
      setStatusSnapshot({ directory: targetDirectory, value: next });
    }
  }, []);
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [localMessage, setLocalMessage] = useState('');
  const scopedMessage = useCommitDraftStore((state) => draftScope ? state.drafts[draftScope] ?? '' : '');
  const setDraft = useCommitDraftStore((state) => state.setDraft);
  const clearIfMatches = useCommitDraftStore((state) => state.clearIfMatches);
  const message = draftScope ? scopedMessage : localMessage;
  const setMessage = (next: string): void => { if (draftScope) setDraft(draftScope, next); else setLocalMessage(next); };
  const [busy, setBusy] = useState<'' | 'commit' | 'stage' | 'revert'>('');
  const [dialog, setDialog] = useState<GitDialogKind>(null);
  const [confirmRevert, setConfirmRevert] = useState<GitStatusFile | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [missingReviewPath, setMissingReviewPath] = useState<string | null>(null);
  const [reviewErrorPath, setReviewErrorPath] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const bumpIndexRevision = useGitStore((state) => state.bumpIndexRevision);
  const moveOptimistic = useGitStore((state) => state.moveStatusPathsOptimistically);
  const restore = useGitStore((state) => state.restoreStatus);
  const statusRef = useRef<GitStatus | null>(null);
  statusRef.current = status;

  const refresh = useCallback(async (): Promise<void> => {
    const next = await ensureStatus(directory, 'full');
    setStatus(directory, next);
    bumpIndexRevision(directory);
    scheduleGitReconcile(directory);
  }, [directory, ensureStatus, bumpIndexRevision, setStatus]);

  // Reveal + §6.4 cadence: full sweep on mount/reveal, then light reconcile.
  useEffect(() => {
    if (!visible || directory.length === 0) return undefined;
    let live = true;
    void (async () => {
      const light = await ensureStatus(directory, 'light');
      if (!live) return;
      setStatus(directory, light);
      const branches = await fetchGitBranches(directory);
      if (!live) return;
      setBranch(branches?.current ?? null);
      setLoading(false);
    })();
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      void ensureStatus(directory, 'light').then((next) => {
        if (live && next !== null) setStatus(directory, next);
      });
    }, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [visible, directory, ensureStatus, setStatus]);

  // Hidden→visible full sweep (§13#1 companion: store caches stay warm).
  useEffect(() => {
    if (!visible || directory.length === 0) return;
    void ensureAll(directory).catch(() => undefined);
    return undefined;
  }, [visible, directory, ensureAll]);

  // Hint replay: §11.4 notifyGitStatusInvalidated → restat soon after.
  useReviewRefreshHints(directory, visible, () => {
    useGitStore.getState().invalidateStatus(directory);
    void ensureStatus(directory, 'light').then((next) => {
      if (next !== null) setStatus(directory, next);
    });
    void fetchGitBranches(directory).then((next) => setBranch(next?.current ?? null));
  });

  const grouped = status !== null ? groupedStatusFiles(status) : { staged: [], working: [] };
  const staged = grouped.staged;
  const working = grouped.working;
  const shownFile = selectedFile?.directory === directory &&
    (selectedFile.staged ? staged : working).some((entry) => entry.path === selectedFile.path) ? selectedFile : null;
  useEffect(() => {
    if (!reviewRequest || reviewRequest.directory !== directory) return;
    // A recent tool completion can precede the Git cache's five-second expiry.
    // Resolve each jump against a fresh status, not the cached initial render.
    let current = true;
    setSelectedFile(null);
    setMissingReviewPath(null);
    setReviewErrorPath(null);
    setReviewLoading(true);
    void fetchGitStatus(directory, 'light').then((fresh) => {
      if (!current) return;
      setReviewLoading(false);
      if (fresh === null) { setReviewErrorPath(reviewRequest.path); return; }
      // Porcelain v1 paths are repository-root-relative, even when the
      // session workspace is a nested directory within that repository.
      const prefix = fresh.workspacePrefix;
      if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix !== '' && !prefix.endsWith('/')
        || /\\|[\u0000-\u001f\u007f]/u.test(prefix)
        || prefix.split('/').some((segment, index, parts) => segment === '..' || segment === '.'
          || segment === '' && index !== parts.length - 1)) {
        setReviewErrorPath(reviewRequest.path);
        return;
      }
      const repoPath = `${prefix}${reviewRequest.path}`;
      useGitStore.getState().applyStatus(directory, fresh, 'light');
      setStatus(directory, fresh);
      const files = groupedStatusFiles(fresh);
      if (files.working.some((entry) => entry.path === repoPath)) {
        setSelectedFile({ directory, path: repoPath, staged: false });
      } else if (files.staged.some((entry) => entry.path === repoPath)) {
        setSelectedFile({ directory, path: repoPath, staged: true });
      } else setMissingReviewPath(reviewRequest.path);
    }).catch(() => { if (current) { setReviewLoading(false); setReviewErrorPath(reviewRequest.path); } });
    return () => { current = false; };
  }, [directory, reviewRequest, setStatus]);

  const withBusy = useCallback(async (kind: 'commit' | 'stage' | 'revert', run: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    try {
      await run();
    } finally {
      setBusy('');
    }
  }, []);

  const stageWithHint = useCallback((paths: string[], direction: 'stage' | 'unstage'): void => {
    void withBusy('stage', async () => {
      const before = statusRef.current;
      try {
        moveOptimistic(directory, paths, direction);
        if (direction === 'stage') await stageGitFiles(directory, paths);
        else await unstageGitFiles(directory, paths);
        bumpIndexRevision(directory);
        scheduleGitReconcile(directory);
        setStatus(directory, await ensureStatus(directory, 'full'));
        publishReviewRefresh(directory, paths, 'git-mutation');
      } catch {
        if (before !== null) restore(directory, before);
        toast.error(direction === 'stage' ? 'Failed to stage file' : 'Failed to unstage file');
      }
    });
  }, [directory, moveOptimistic, restore, bumpIndexRevision, ensureStatus, withBusy, setStatus]);

  const discardWithHint = useCallback((paths: string[]): void => {
    void withBusy('revert', async () => {
      try {
        await discardGitFiles(directory, paths);
        await refresh();
        publishReviewRefresh(directory, paths, 'git-mutation');
      } catch {
        toast.error('Failed to discard changes');
      }
    });
  }, [directory, refresh, withBusy]);

  const commit = useCallback((sync: boolean): void => {
    void withBusy('commit', async () => {
      const submittedMessage = message;
      if (submittedMessage.trim().length === 0) {
        toast.error('Enter a commit message');
        return;
      }
      try {
        await commitChanges(directory, submittedMessage);
      } catch {
        toast.error('Failed to create commit');
        return;
      }
      toast.success('Commit created');
      if (draftScope) clearIfMatches(draftScope, submittedMessage);
      else setLocalMessage((current) => current === submittedMessage ? '' : current);
      bumpIndexRevision(directory);
      await refresh();
      publishReviewRefresh(directory, null, 'git-mutation');
      if (sync) toast.message('Commit created — push rides with the P11 routes');
    });
  }, [directory, message, draftScope, clearIfMatches, refresh, withBusy, bumpIndexRevision]);

  if (loading || statusSnapshot?.directory !== directory) {
    return <Centered label="Checking repository..." testid="git-view-loading" />;
  }
  if (status === null || status.isGitRepository === false) {
    return <Centered label="Not a git repository. Use the Git tab to initialize or change directories." testid="git-empty" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-2" data-testid="git-view">
      <header className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
        <span className="text-xs font-medium text-foreground" data-testid="git-branch">{branch ?? 'Detached HEAD'}</span>
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Current</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-history" onClick={() => setDialog('history')}>History</button>
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-branches" onClick={() => setDialog('branches')}>Branches</button>
          {onOpenWalkthrough ? <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-walkthrough" onClick={onOpenWalkthrough}>Walkthrough</button> : null}
        </span>
      </header>
      <div className={`flex min-h-0 flex-1 gap-3 ${compact ? 'flex-col' : ''}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Section
            title="Staged"
            accent
            primaryLabel="Unstage all"
            onPrimary={staged.length > 0 ? () => stageWithHint(staged.map((entry) => entry.path), 'unstage') : undefined}
          >
            {staged.map((entry) => (
              <FileRow
                key={`staged:${entry.path}`}
                entry={entry}
                staged
                selected={shownFile?.path === entry.path && shownFile.staged}
                onOpen={() => { setMissingReviewPath(null); setReviewErrorPath(null); setSelectedFile({ directory, path: entry.path, staged: true }); }}
                onStageToggle={() => stageWithHint([entry.path], 'unstage')}
                onRevert={() => setConfirmRevert(entry)}
              />
            ))}
            {staged.length === 0 ? <EmptyLine label="No staged changes" /> : null}
          </Section>
          <Section
            title="Changes"
            primaryLabel="Stage all"
            onPrimary={working.length > 0 ? () => stageWithHint(working.map((entry) => entry.path), 'stage') : undefined}
          >
            {working.map((entry) => (
              <FileRow
                key={`working:${entry.path}`}
                entry={entry}
                staged={false}
                selected={shownFile?.path === entry.path && !shownFile.staged}
                onOpen={() => { setMissingReviewPath(null); setReviewErrorPath(null); setSelectedFile({ directory, path: entry.path, staged: false }); }}
                onStageToggle={() => stageWithHint([entry.path], 'stage')}
                onRevert={() => setConfirmRevert(entry)}
              />
            ))}
            {working.length === 0 ? <EmptyLine label="No changes" /> : null}
          </Section>
        </div>
        <aside className={`flex min-h-0 shrink-0 flex-col gap-3 overflow-y-auto ${compact ? 'w-full' : shownFile ? 'w-[min(45vw,520px)]' : 'w-72'}`}>
          {reviewLoading && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-neutral-400">Checking current Changes…</p> : null}
          {reviewErrorPath && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-amber-300">
            Could not check current Changes for {reviewErrorPath}.
          </p> : null}
          {missingReviewPath && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-amber-300">
            {missingReviewPath} is no longer in current Changes.
          </p> : null}
          {shownFile ? <GitFilePreview key={`${directory}\u0000${shownFile.path}\u0000${shownFile.staged}`} directory={directory}
            path={shownFile.path} staged={shownFile.staged} revision={status} onClose={() => setSelectedFile(null)} /> : null}
          <div className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Commit</div>
            <textarea
              className="h-20 w-full rounded border border-border/50 bg-interactive-hover/30 p-2 text-xs text-foreground outline-none"
              placeholder="Commit message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy !== '' || message.trim().length === 0 || staged.length === 0}
                className="rounded bg-primary/20 px-3 py-1 text-xs text-primary disabled:opacity-40"
                data-testid="git-commit"
                onClick={() => commit(false)}
              >
                {busy === 'commit' ? 'Committing...' : 'Commit'}
              </button>
              <button
                type="button"
                disabled={busy !== '' || message.trim().length === 0 || staged.length === 0}
                className="rounded border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={() => commit(true)}
              >
                {busy === 'commit' ? 'Syncing...' : 'Commit & sync'}
              </button>
            </div>
            {staged.length === 0 ? <div className="mt-2 text-[11px] text-muted-foreground">Stage files to enable commit.</div> : null}
          </div>
        </aside>
      </div>
      <GitDialogHost directory={directory} onClose={() => setDialog(null)} dialog={dialog} />
      {confirmRevert !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="git-revert-dialog">
          <div className="w-80 rounded-lg border border-border/60 bg-card p-4">
            <div className="text-sm font-medium text-foreground">Revert changes</div>
            <div className="mt-1 text-xs text-muted-foreground">{`Are you sure you want to revert ${confirmRevert.path}? This cannot be undone.`}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setConfirmRevert(null)}>Cancel</button>
              <button type="button" className="rounded bg-status-error/20 px-3 py-1 text-xs text-status-error" data-testid="git-revert-confirm" onClick={() => {
                setConfirmRevert(null);
                discardWithHint([confirmRevert.path]);
              }}>Revert</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Centered({ label, testid }: { label: string; testid: string }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground" data-testid={testid}>
      {label}
    </div>
  );
}

function Section({
  title, accent, primaryLabel, onPrimary, children,
}: {
  title: string;
  accent?: boolean;
  primaryLabel: string;
  onPrimary?: (() => void) | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={`rounded-lg border p-2 ${accent ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-card/40'}`}>
      <header className="mb-1 flex items-center gap-2 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        {onPrimary !== undefined ? (
          <button
            type="button"
            className={`ml-auto rounded px-1.5 text-[10px] hover:text-foreground ${accent ? 'text-primary' : 'text-muted-foreground'}`}
            data-testid={`git-${title.toLowerCase()}-primary`}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function FileRow({ entry, staged, selected, onOpen, onStageToggle, onRevert }: {
  entry: GitStatusFile;
  staged: boolean;
  selected: boolean;
  onOpen: () => void;
  onStageToggle: () => void;
  onRevert: () => void;
}): ReactNode {
  const symbol = statusSymbol(entry);
  return (
    <div className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-interactive-hover/30" data-testid="git-file-row" data-scope={staged ? 'staged' : 'working'} data-path={entry.path}>
      <span className="w-4 text-center text-[11px]" style={{ color: symbolColorOf(symbol) }}>{symbol}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:text-primary"
        title={entry.path}
        data-testid="git-file-name"
        aria-label={`View diff for ${entry.path} (${staged ? 'staged' : 'working'})`}
        aria-pressed={selected}
        onClick={onOpen}
      >
        {entry.path}
      </button>
      <button
        type="button"
        aria-label={staged ? `Unstage ${entry.path}` : `Stage ${entry.path}`}
        data-testid={`git-file-${staged ? 'unstage' : 'stage'}`}
        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={onStageToggle}
      >
        {staged ? 'Unstage' : 'Stage'}
      </button>
      <button
        type="button"
        aria-label={staged ? `Unstage changes in ${entry.path}` : `Discard changes in ${entry.path}`}
        className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-status-error"
        data-testid={`git-file-revert-${staged ? 'staged' : 'working'}`}
        onClick={onRevert}
      >
        ↺
      </button>
    </div>
  );
}

function EmptyLine({ label }: { label: string }): ReactNode {
  return <div className="px-2 py-1 text-[11px] text-muted-foreground">{label}</div>;
}

function symbolColorOf(symbol: string): string {
  if (symbol === 'A') return 'var(--status-success)';
  if (symbol === 'D') return 'var(--status-error)';
  if (symbol === 'M') return 'var(--status-warning)';
  return 'var(--status-info)';
}
