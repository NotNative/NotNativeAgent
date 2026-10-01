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
  checkoutLocalBranch, commitChanges, createLocalBranch, discardGitFiles, fetchGitStatus, stageGitFiles, syncGitBranch, unstageGitFiles,
  statusSymbol, type GitStatus, type GitStatusFile,
} from '../../lib/git/api';
import { publishReviewRefresh, useReviewRefreshHints } from '../../lib/git/refresh-hints';
import { GIT_STATUS_POLL_INTERVAL_MS } from '../../lib/files/edit-support.ts';
import { useCommitDraftStore } from '../../lib/git/commit-drafts.ts';
import { GitDialogHost, type GitDialogKind } from './git-dialogs.tsx';
import { GitFilePreview } from './git-file-preview.tsx';
import { BranchTracking, StatusFailure, gitError, symbolColorOf } from './git-view-chrome.tsx';
import { SessionChanges } from './session-changes.tsx';
import { repoPathFromWorkspace } from './session-change-evidence.ts';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../../sync/types.ts';
import { useI18n } from '../../lib/i18n/context.tsx';
type SelectedFile = { directory: string; path: string; staged: boolean };
type ReviewRequest = { directory: string; path: string; id: number } | null;
export function GitView({ directory, visible = true, compact = false, reviewRequest = null, onOpenWalkthrough, draftScope, activityStore, sessionID }: {
  directory: string; visible?: boolean; compact?: boolean; reviewRequest?: ReviewRequest; onOpenWalkthrough?: () => void; draftScope?: string;
  activityStore?: StoreApi<DirectoryStore>; sessionID?: string | null;
}): ReactNode {
  const { t } = useI18n();
  const [statusSnapshot, setStatusSnapshot] = useState<{ directory: string; value: GitStatus } | null>(null);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  const status = statusSnapshot?.directory === directory ? statusSnapshot.value : null;
  const setStatus = useCallback((targetDirectory: string, next: GitStatus | null): void => {
    if (next !== null && currentDirectory.current === targetDirectory) {
      setStatusSnapshot({ directory: targetDirectory, value: next });
    }
  }, []);
  const [loading, setLoading] = useState(true);
  const [statusFailure, setStatusFailure] = useState<string | null>(null);
  const statusStale = statusFailure === directory;
  const [retryRevision, setRetryRevision] = useState(0);
  const [localMessage, setLocalMessage] = useState('');
  const scopedMessage = useCommitDraftStore((state) => draftScope ? state.drafts[draftScope] ?? '' : '');
  const setDraft = useCommitDraftStore((state) => state.setDraft);
  const clearIfMatches = useCommitDraftStore((state) => state.clearIfMatches);
  const message = draftScope ? scopedMessage : localMessage;
  const setMessage = (next: string): void => { if (draftScope) setDraft(draftScope, next); else setLocalMessage(next); };
  const [busy, setBusy] = useState<'' | 'commit' | 'stage' | 'revert' | 'sync' | 'switch'>('');
  const [dialog, setDialog] = useState<GitDialogKind>(null);
  const [confirmRevert, setConfirmRevert] = useState<GitStatusFile | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [missingReviewPath, setMissingReviewPath] = useState<string | null>(null);
  const [reviewErrorPath, setReviewErrorPath] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const invalidateStatus = useGitStore((state) => state.invalidateStatus);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const bumpIndexRevision = useGitStore((state) => state.bumpIndexRevision);
  const moveOptimistic = useGitStore((state) => state.moveStatusPathsOptimistically);
  const restore = useGitStore((state) => state.restoreStatus);
  const statusRef = useRef<GitStatus | null>(null);
  statusRef.current = status;
  const statusRequestRevision = useRef(0);

  const retryStatus = useCallback((): void => {
    // A manual retry must prove the service recovered, not accept a status
    // snapshot another view happened to put in the short-lived shared cache.
    invalidateStatus(directory);
    setRetryRevision((value) => value + 1);
  }, [directory, invalidateStatus]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const next = await ensureStatus(directory, 'full');
    setStatus(directory, next);
    bumpIndexRevision(directory);
    scheduleGitReconcile(directory);
    return next !== null;
  }, [directory, ensureStatus, bumpIndexRevision, setStatus]);

  // Reveal + §6.4 cadence: full sweep on mount/reveal, then light reconcile.
  useEffect(() => {
    if (!visible || directory.length === 0) return undefined;
    let live = true;
    void (async () => {
      const revision = statusRequestRevision.current;
      try {
        const light = await ensureStatus(directory, 'light');
        if (!live || revision !== statusRequestRevision.current) return;
        if (light === null) setStatusFailure(directory);
        else { setStatus(directory, light); setStatusFailure(null); }
      } catch {
        if (live && revision === statusRequestRevision.current) setStatusFailure(directory);
      } finally {
        if (live && revision === statusRequestRevision.current) setLoading(false);
      }
    })();
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      const revision = statusRequestRevision.current;
      void ensureStatus(directory, 'light').then((next) => {
        if (!live || revision !== statusRequestRevision.current) return;
        if (next === null) setStatusFailure(directory);
        else { setStatus(directory, next); setStatusFailure(null); }
      }).catch(() => { if (live && revision === statusRequestRevision.current) setStatusFailure(directory); });
    }, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [visible, directory, ensureStatus, setStatus, retryRevision]);

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
  });

  const grouped = status !== null ? groupedStatusFiles(status) : { staged: [], working: [] };
  const staged = grouped.staged, working = grouped.working;
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
      const repoPath = repoPathFromWorkspace(fresh.workspacePrefix, reviewRequest.path);
      if (repoPath === null) {
        setReviewErrorPath(reviewRequest.path);
        return;
      }
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

  const withBusy = useCallback(async (kind: 'commit' | 'stage' | 'revert' | 'sync' | 'switch', run: () => Promise<void>): Promise<void> => {
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
        toast.error(direction === 'stage' ? t('gitUi.stageFailed') : t('gitUi.unstageFailed'));
      }
    });
  }, [directory, moveOptimistic, restore, bumpIndexRevision, ensureStatus, withBusy, setStatus, t]);

  const discardWithHint = useCallback((paths: string[]): void => {
    void withBusy('revert', async () => {
      try {
        await discardGitFiles(directory, paths);
        await refresh();
        publishReviewRefresh(directory, paths, 'git-mutation');
      } catch {
        toast.error(t('gitUi.discardFailed'));
      }
    });
  }, [directory, refresh, withBusy, t]);

  const commit = useCallback((sync: boolean): void => {
    void withBusy(sync ? 'sync' : 'commit', async () => {
      const submittedMessage = message;
      if (submittedMessage.trim().length === 0) {
        toast.error(t('gitUi.enterCommitMessage'));
        return;
      }
      try {
        await commitChanges(directory, submittedMessage);
      } catch {
        toast.error(t('gitUi.commitFailed'));
        return;
      }
      if (draftScope) clearIfMatches(draftScope, submittedMessage);
      else setLocalMessage((current) => current === submittedMessage ? '' : current);
      let synced = false;
      if (sync) {
        try { await syncGitBranch(directory); synced = true; }
        catch (error) { toast.error(t('gitUi.createdLocallySyncFailed', { error: gitError(error, t('gitUi.gitOperationFailed')) })); }
      }
      if (!sync || synced) toast.success(sync ? t('gitUi.commitCreatedAndSynced') : t('gitUi.commitCreated'));
      bumpIndexRevision(directory);
      await refresh();
      publishReviewRefresh(directory, null, 'git-mutation');
    });
  }, [directory, message, draftScope, clearIfMatches, refresh, withBusy, bumpIndexRevision, t]);

  const syncBranch = useCallback((): void => {
    void withBusy('sync', async () => {
      try {
        await syncGitBranch(directory);
        toast.success(t('gitUi.branchSynced'));
        await refresh();
        publishReviewRefresh(directory, null, 'git-mutation');
      } catch (error) { toast.error(t('gitUi.syncFailed', { error: gitError(error, t('gitUi.gitOperationFailed')) })); }
    });
  }, [directory, refresh, withBusy, t]);

  const changeBranch = useCallback(async (branch: string, expectedBranch: string, create = false): Promise<void> => {
    if (statusFailure === directory) throw new Error(t('gitUi.statusRefreshRequired'));
    await withBusy('switch', async () => {
      if (create) await createLocalBranch(directory, branch, expectedBranch);
      else await checkoutLocalBranch(directory, branch, expectedBranch);
      statusRequestRevision.current += 1;
      setSelectedFile(null);
      useGitStore.getState().invalidateStatus(directory);
      let refreshed = false;
      try {
        if (!await refresh()) throw new Error(t('gitUi.gitStatusUnavailable'));
        setStatusFailure(null);
        refreshed = true;
      }
      catch { setStatusFailure(directory); toast.error(t('gitUi.statusRefreshFailed')); }
      publishReviewRefresh(directory, null, 'git-mutation');
      if (refreshed) toast.success(create ? t('gitUi.branchCreatedAndSwitched', { branch }) : t('gitUi.branchSwitched', { branch }));
    });
  }, [directory, refresh, statusFailure, withBusy, t]);

  if (directory.length === 0) {
    return <Centered label={t('gitUi.selectWorkspace')} testid="git-empty" />;
  }
  if (statusFailure === directory && status === null) {
    return <StatusFailure onRetry={retryStatus} />;
  }
  if (loading || statusSnapshot?.directory !== directory) {
    return <Centered label={t('gitUi.checkingRepository')} testid="git-view-loading" />;
  }
  if (status === null || status.isGitRepository === false) {
    return <Centered label={t('gitUi.notGitRepository')} testid="git-empty" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-2" data-testid="git-view">
      {statusStale ? <div role="status" className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300" data-testid="git-status-stale">
        {t('gitUi.staleStatus')}
        <button type="button" className="ml-auto underline" onClick={retryStatus}>{t('gitUi.retry')}</button>
      </div> : null}
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
        <span className="min-w-0 truncate text-xs font-medium text-foreground" data-testid="git-branch">{status.branch ?? t('gitUi.detachedHead')}</span>
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">{t('gitUi.current')}</span>
        <BranchTracking status={status} />
        <span className={`flex flex-wrap items-center gap-1 ${compact ? 'w-full justify-end' : 'ml-auto'}`}>
          <button type="button" disabled={busy !== '' || statusStale} className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            data-testid="git-sync" onClick={syncBranch}>{busy === 'sync' ? t('gitUi.syncing') : t('gitUi.syncBranch')}</button>
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-history" onClick={() => setDialog('history')}>{t('gitUi.history')}</button>
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-branches" onClick={() => setDialog('branches')}>{t('gitUi.branches')}</button>
          {onOpenWalkthrough ? <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-open-walkthrough" onClick={onOpenWalkthrough}>{t('gitUi.walkthrough')}</button> : null}
        </span>
      </header>
      <div className={`flex min-h-0 flex-1 gap-3 ${compact ? 'flex-col' : ''}`}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="git-changes-scroll">
          {activityStore ? <SessionChanges store={activityStore} directory={directory} sessionID={sessionID ?? null} visible={visible}
            status={status} stale={statusStale} onOpen={(path, stagedFile) => {
              setMissingReviewPath(null); setReviewErrorPath(null); setSelectedFile({ directory, path, staged: stagedFile });
            }} /> : null}
          <Section
            title={t('gitUi.sectionStaged')}
            sectionId="staged"
            count={staged.length}
            accent
            primaryLabel={t('gitUi.unstageAll')}
            onPrimary={staged.length > 0 && !statusStale ? () => stageWithHint(staged.map((entry) => entry.path), 'unstage') : undefined}
          >
            {staged.map((entry) => (
              <FileRow
                key={`staged:${entry.path}`}
                entry={entry}
                staged
                mutationDisabled={statusStale}
                selected={shownFile?.path === entry.path && shownFile.staged}
                onOpen={() => { setMissingReviewPath(null); setReviewErrorPath(null); setSelectedFile({ directory, path: entry.path, staged: true }); }}
                onStageToggle={() => stageWithHint([entry.path], 'unstage')}
                onRevert={() => setConfirmRevert(entry)}
              />
            ))}
            {staged.length === 0 ? <EmptyLine label={t('gitUi.noStagedChanges')} /> : null}
          </Section>
          <Section
            title={t('gitUi.sectionChanges')}
            sectionId="changes"
            count={working.length}
            primaryLabel={t('gitUi.stageAll')}
            onPrimary={working.length > 0 && !statusStale ? () => stageWithHint(working.map((entry) => entry.path), 'stage') : undefined}
          >
            {working.map((entry) => (
              <FileRow
                key={`working:${entry.path}`}
                entry={entry}
                staged={false}
                mutationDisabled={statusStale}
                selected={shownFile?.path === entry.path && !shownFile.staged}
                onOpen={() => { setMissingReviewPath(null); setReviewErrorPath(null); setSelectedFile({ directory, path: entry.path, staged: false }); }}
                onStageToggle={() => stageWithHint([entry.path], 'stage')}
                onRevert={() => setConfirmRevert(entry)}
              />
            ))}
            {working.length === 0 ? <EmptyLine label={t('gitUi.noChanges')} /> : null}
          </Section>
        </div>
        <aside className={`flex min-h-0 shrink-0 flex-col overflow-hidden ${compact ? 'max-h-[55%] w-full' : shownFile ? 'w-[min(45vw,520px)]' : 'w-72'}`}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto" data-testid="git-review-scroll">
            {reviewLoading && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-neutral-400">{t('gitUi.reviewChecking')}</p> : null}
            {reviewErrorPath && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-amber-300">
              {t('gitUi.reviewCheckFailed', { path: reviewErrorPath })}
            </p> : null}
            {missingReviewPath && reviewRequest?.directory === directory ? <p role="status" className="text-xs text-amber-300">
              {t('gitUi.reviewPathMissing', { path: missingReviewPath })}
            </p> : null}
            {shownFile ? <GitFilePreview key={`${directory}\u0000${shownFile.path}\u0000${shownFile.staged}`} directory={directory}
              path={shownFile.path} staged={shownFile.staged} revision={status} onClose={() => setSelectedFile(null)} /> : null}
          </div>
          <div className="mt-3 shrink-0 rounded-lg border border-border/60 bg-card/40 p-3" data-testid="git-commit-dock">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('gitUi.commit')}</div>
            <textarea
              className="h-20 w-full rounded border border-border/50 bg-interactive-hover/30 p-2 text-xs text-foreground outline-none"
              placeholder={t('gitUi.commitMessage')}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy !== '' || statusStale || message.trim().length === 0 || staged.length === 0}
                className="rounded bg-primary/20 px-3 py-1 text-xs text-primary disabled:opacity-40"
                data-testid="git-commit"
                onClick={() => commit(false)}
              >
                {busy === 'commit' ? t('gitUi.committing') : t('gitUi.commit')}
              </button>
              <button
                type="button"
                disabled={busy !== '' || statusStale || message.trim().length === 0 || staged.length === 0}
                className="rounded border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={() => commit(true)}
              >
                {busy === 'sync' ? t('gitUi.syncing') : t('gitUi.commitAndSync')}
              </button>
            </div>
            {staged.length === 0 ? <div className="mt-2 text-[11px] text-muted-foreground">{t('gitUi.stageFilesToCommit')}</div> : null}
          </div>
        </aside>
      </div>
      <GitDialogHost directory={directory} onClose={() => setDialog(null)} dialog={dialog}
        onSwitchBranch={changeBranch} switchingDisabled={statusStale || busy !== ''} />
      {confirmRevert !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="git-revert-dialog">
          <div className="w-80 rounded-lg border border-border/60 bg-card p-4">
            <div className="text-sm font-medium text-foreground">{t('gitUi.revertTitle')}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('gitUi.revertConfirm', { path: confirmRevert.path })}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setConfirmRevert(null)}>{t('gitUi.cancel')}</button>
              <button type="button" disabled={statusStale} className="rounded bg-status-error/20 px-3 py-1 text-xs text-status-error disabled:opacity-40" data-testid="git-revert-confirm" onClick={() => {
                setConfirmRevert(null);
                discardWithHint([confirmRevert.path]);
              }}>{t('gitUi.revert')}</button>
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
  title, sectionId, count, accent, primaryLabel, onPrimary, children,
}: {
  title: string;
  sectionId: string;
  count: number;
  accent?: boolean;
  primaryLabel: string;
  onPrimary?: (() => void) | undefined;
  children: ReactNode;
}): ReactNode {
  const [expanded, setExpanded] = useState(true);
  const { t } = useI18n();
  const toggle = t(expanded ? 'gitUi.collapseSection' : 'gitUi.expandSection', { section: title });
  return (
    <section className={`rounded-lg border p-2 ${accent ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-card/40'}`}>
      <header className="mb-1 flex items-center gap-2 px-1">
        <button type="button" aria-expanded={expanded} aria-label={toggle}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          data-testid={`git-${sectionId}-toggle`} onClick={() => setExpanded((value) => !value)}>
          <span aria-hidden="true" className="w-3 text-center">{expanded ? '⌄' : '›'}</span>{title} <span className="font-normal">{count}</span>
        </button>
        {onPrimary !== undefined ? (
          <button
            type="button"
            className={`ml-auto rounded px-1.5 text-[10px] hover:text-foreground ${accent ? 'text-primary' : 'text-muted-foreground'}`}
            data-testid={`git-${sectionId}-primary`}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        ) : null}
      </header>
      {expanded ? children : null}
    </section>
  );
}

function FileRow({ entry, staged, selected, mutationDisabled, onOpen, onStageToggle, onRevert }: {
  entry: GitStatusFile;
  staged: boolean;
  selected: boolean;
  mutationDisabled: boolean;
  onOpen: () => void;
  onStageToggle: () => void;
  onRevert: () => void;
}): ReactNode {
  const { t } = useI18n();
  const symbol = statusSymbol(entry);
  return (
    <div className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-interactive-hover/30" data-testid="git-file-row" data-scope={staged ? 'staged' : 'working'} data-path={entry.path}>
      <span className="w-4 text-center text-[11px]" style={{ color: symbolColorOf(symbol) }}>{symbol}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:text-primary"
        title={entry.path}
        data-testid="git-file-name"
        aria-label={t('gitUi.viewDiff', { path: entry.path, scope: staged ? t('gitUi.staged') : t('gitUi.working') })}
        aria-pressed={selected}
        onClick={onOpen}
      >
        {entry.path}
      </button>
      <button
        type="button"
        disabled={mutationDisabled}
        aria-label={t(staged ? 'gitUi.unstageAria' : 'gitUi.stageAria', { path: entry.path })}
        data-testid={`git-file-${staged ? 'unstage' : 'stage'}`}
        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={onStageToggle}
      >
        {staged ? t('gitUi.unstageButton') : t('gitUi.stageButton')}
      </button>
      <button
        type="button"
        disabled={mutationDisabled}
        aria-label={t(staged ? 'gitUi.unstageAria' : 'gitUi.discardAria', { path: entry.path })}
        className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-status-error disabled:opacity-40"
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
