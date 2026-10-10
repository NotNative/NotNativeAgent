// SPDX-License-Identifier: Apache-2.0
/**
 * Git dialogs (doc 06 §6.8 History + branch list): the
 * /api/git/log + /api/git/branches read family with a maxCount selector
 * (25/50/100) + Load more and per-commit Copy SHA; checkout/rebase/reset
 * local checkout action uses an explicit clean-worktree server preflight;
 * remote tracking, creation, and other branch mutations remain separate.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyGitStash, createGitStash, fetchGitBranches, fetchGitLog, fetchGitStashes, type GitBranch,
} from '../../lib/git/api';
import { useI18n } from '../../lib/i18n/context.tsx';
import { computeCommitLanes, type LaneRow } from '../../lib/git/graph-lanes.ts';

type GitLogEntry = NonNullable<Awaited<ReturnType<typeof fetchGitLog>>>['commits'][number];

const MAX_COUNT_STEPS = [25, 50, 100] as const;

export type GitDialogKind = 'history' | 'branches' | 'stashes' | null;

export function GitDialogHost({ directory, onClose, dialog, onSwitchBranch, switchingDisabled = false, onApplied }: {
  directory: string;
  onClose: () => void;
  dialog: GitDialogKind;
  onSwitchBranch?: (branch: string, expectedBranch: string, create?: boolean) => Promise<void>;
  switchingDisabled?: boolean;
  onApplied?: () => void;
}): ReactNode {
  if (directory.length === 0 || dialog === null) return null;
  if (dialog === 'history') return <GitHistoryDialog directory={directory} onClose={onClose} />;
  if (dialog === 'stashes') return <GitStashesDialog directory={directory} onClose={onClose} onApplied={onApplied} />;
  return <GitBranchesDialog key={directory} directory={directory} onClose={onClose} onSwitchBranch={onSwitchBranch} switchingDisabled={switchingDisabled} />;
}

function GitHistoryDialog({ directory, onClose }: { directory: string; onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null);
  const [maxCount, setMaxCount] = useState<number>(50);
  const [failed, setFailed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const live = useRef(true);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  useEffect(() => {
    let live = true;
    setCommits(null);
    setFailed(false);
    setCopyFailed(false);
    void fetchGitLog(directory, maxCount).then((result) => {
      if (!live) return;
      if (result === null) {
        setFailed(true);
        return;
      }
      setCommits(Array.isArray(result.commits) ? result.commits : []);
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [directory, maxCount]);

  const copySha = useCallback(async (hash: string): Promise<void> => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(hash);
      if (!live.current) return;
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
      setCopied(hash);
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = undefined;
        setCopied(null);
      }, 1_500);
    } catch {
      if (!live.current) return;
      setCopyFailed(true);
      setCopied(null);
    }
    return undefined;
  }, []);

  const lanes = useMemo(() => computeCommitLanes(commits ?? []), [commits]);

  return (
    <DialogShell title={t('gitUi.history.title')} wide onClose={onClose} testid="git-history-dialog">
      <div className="mb-2 flex items-center gap-2" role="group" aria-label={t('gitUi.history.logSize')}>
        {MAX_COUNT_STEPS.map((step) => (
          <button
            key={step}
            type="button"
            aria-pressed={maxCount === step}
            data-testid={`git-history-maxcount-${step}`}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${maxCount === step ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground'}`}
            onClick={() => setMaxCount(step)}
          >
            {step}
          </button>
        ))}
        {commits !== null && commits.length >= maxCount && maxCount < 500 ? (
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-history-load-more" onClick={() => setMaxCount(Math.min(500, maxCount + 50))}>{t('gitUi.history.loadMore')}</button>
        ) : null}
      </div>
      {failed ? <div role="alert" className="text-xs text-status-error" data-testid="git-history-failed">{t('gitUi.history.loadFailed')}</div> : null}
      {copyFailed ? <div role="alert" className="text-xs text-status-error" data-testid="git-history-copy-failed">{t('gitUi.history.copyFailed')}</div> : null}
      {commits === null && !failed ? <div className="text-xs text-muted-foreground">{t('gitUi.history.loading')}</div> : null}
      <div className="flex flex-col gap-1">
        {(commits ?? []).map((commit, at) => (
          <div key={commit.hash} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-foreground hover:bg-interactive-hover/30" data-testid="git-history-row">
            <HistoryGraphGlyph row={lanes[at]} />
            <span className="font-mono text-[10px] text-muted-foreground">{commit.hash.slice(0, 8)}</span>
            <span className="min-w-0 flex-1 truncate" title={commit.subject}>{commit.subject}</span>
            <span className="text-[10px] text-muted-foreground">{commit.author}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">{formatLogDate(commit.date)}</span>
            <button
              type="button"
              aria-label={t('gitUi.history.copyCommitSha', { hash: commit.hash })}
              data-testid="git-history-copy"
              className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void copySha(commit.hash)}
            >
              {copied === commit.hash ? t('gitUi.history.copied') : t('gitUi.history.copySha')}
            </button>
          </div>
        ))}
        {commits !== null && commits.length === 0 ? <div className="text-xs text-muted-foreground">{t('gitUi.history.empty')}</div> : null}
      </div>
    </DialogShell>
  );
}

function GitBranchesDialog({ directory, onClose, onSwitchBranch, switchingDisabled }: {
  directory: string; onClose: () => void; onSwitchBranch?: (branch: string, expectedBranch: string, create?: boolean) => Promise<void>; switchingDisabled: boolean;
}): ReactNode {
  const { t } = useI18n();
  const { branches, failed, pending, switchError, runBranchAction } = useBranchActions(directory, onClose, onSwitchBranch, switchingDisabled);
  const [query, setQuery] = useState('');
  const [newBranch, setNewBranch] = useState('');

  const search = query.trim().toLocaleLowerCase();
  const matches = (name: string): boolean => name.toLocaleLowerCase().includes(search);

  return (
    <DialogShell title={t('gitUi.branches.title')} onClose={onClose} testid="git-branches-dialog">
      {failed ? <div role="alert" className="text-xs text-status-error" data-testid="git-branches-failed">{t('gitUi.branches.loadFailed')}</div> : null}
      {branches === null && !failed ? <div className="text-xs text-muted-foreground">{t('gitUi.branches.loading')}</div> : null}
      {branches !== null ? (
        <div className="flex flex-col gap-2 text-xs text-foreground">
          <input type="search" aria-label={t('gitUi.branches.searchLabel')} placeholder={t('gitUi.branches.searchPlaceholder')} value={query}
            onChange={(event) => setQuery(event.target.value)} className="rounded border border-border/60 bg-transparent px-2 py-1 text-xs outline-none" />
          {switchError ? <div role="alert" className="text-status-error" data-testid="git-branch-switch-error">{switchError}</div> : null}
          <BranchGroup groupId="local" label={t('gitUi.branches.local')} names={branches.local.filter(matches)} current={branches.current}
            onSwitch={branches.current ? (branch) => { void runBranchAction(branch); } : undefined} switchingDisabled={switchingDisabled || pending !== null} pending={pending} />
          {branches.remote.some(matches) ? <BranchGroup groupId="remote" label={t('gitUi.branches.remote')} names={branches.remote.filter(matches)} current={null} /> : null}
          {branches.local.length === 0 && branches.remote.length === 0 ? <div className="text-muted-foreground">{t('gitUi.branches.empty')}</div> : null}
          {search && !branches.local.some(matches) && !branches.remote.some(matches) ? <div className="text-muted-foreground">{t('gitUi.branches.searchEmpty')}</div> : null}
          {branches.current === null ? <div className="text-muted-foreground">{t('gitUi.branches.noCurrent')}</div> : null}
          {branches.current !== null && onSwitchBranch ? <form className="mt-2 flex gap-2 border-t border-border/60 pt-3" onSubmit={(event) => {
            event.preventDefault();
            const name = newBranch.trim();
            if (name) void runBranchAction(name, true);
          }}>
            <input type="text" aria-label={t('gitUi.branches.createNameLabel')} placeholder={t('gitUi.branches.createNamePlaceholder')} value={newBranch} maxLength={200}
              onChange={(event) => setNewBranch(event.target.value)} className="min-w-0 flex-1 rounded border border-border/60 bg-transparent px-2 py-1 text-xs outline-none" />
            <button type="submit" disabled={switchingDisabled || pending !== null || newBranch.trim().length === 0}
              className="rounded border border-border/60 px-2 py-1 text-xs disabled:opacity-40" data-testid="git-create-branch">
              {pending === newBranch.trim() ? t('gitUi.branches.creating') : t('gitUi.branches.createAndSwitch')}
            </button>
          </form> : null}
        </div>
      ) : null}
    </DialogShell>
  );
}

/** Load branch state and retain the action lifecycle until the dialog closes. */
function useBranchActions(
  directory: string,
  onClose: () => void,
  onSwitchBranch: ((branch: string, expectedBranch: string, create?: boolean) => Promise<void>) | undefined,
  switchingDisabled: boolean,
) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranch | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState('');
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setBranches(null);
    setFailed(false);
    void fetchGitBranches(directory).then((result) => {
      if (!live) return;
      if (result === null) {
        setFailed(true);
        return;
      }
      setBranches(result);
    }).catch(() => { if (live) setFailed(true); });
    return () => {
      live = false;
    };
  }, [directory]);

  const runBranchAction = async (branch: string, create = false): Promise<void> => {
    if (!branches?.current || !onSwitchBranch || pending || switchingDisabled) return;
    setSwitchError('');
    setPending(branch);
    try { await onSwitchBranch(branch, branches.current, create); if (live.current) onClose(); }
    catch (error) { if (live.current) setSwitchError(error instanceof Error ? error.message : t('gitUi.branches.switchFailed')); }
    finally { if (live.current) setPending(null); }
  };

  return { branches, failed, pending, switchError, runBranchAction };
}

function BranchGroup({ groupId, label, names, current, onSwitch, switchingDisabled = false, pending = null }: {
  groupId: string; label: string; names: string[]; current: string | null; onSwitch?: (branch: string) => void; switchingDisabled?: boolean; pending?: string | null;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div data-testid={`git-branch-group-${groupId}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-0.5">
        {names.map((name) => (
          <div key={name} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-interactive-hover/30" data-testid="git-branch-row">
            <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
            {current === name ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">{t('gitUi.branches.current')}</span> : null}
            {onSwitch && current !== name ? <button type="button" disabled={switchingDisabled}
              aria-label={t('gitUi.branches.switchAria', { name })} className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => onSwitch(name)}>{pending === name ? t('gitUi.branches.switching') : t('gitUi.branches.switch')}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** F6.3 stash lifecycle: list/create/apply/drop against /api/git/stashes.
 * Apply keeps the stash entry; drop removes it without applying. */
function GitStashesDialog({ directory, onClose, onApplied }: {
  directory: string; onClose: () => void; onApplied?: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [stashes, setStashes] = useState<{ ref: string; subject: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      const result = await fetchGitStashes(directory);
      if (result === null) { setFailed(true); return; }
      setStashes(Array.isArray(result.stashes) ? result.stashes : []);
    } catch {
      setFailed(true);
    }
  }, [directory]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setActionFailed(false);
    try {
      await action();
      await load();
      onApplied?.();
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  }, [load, onApplied]);

  return (
    <DialogShell title={t('gitUi.stashes.title')} onClose={onClose} testid="git-stashes-dialog">
      <div className="mb-2 flex justify-end">
        <button type="button" disabled={busy} data-testid="git-stash-create"
          className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={() => void act(() => createGitStash(directory, null))}>
          {t('gitUi.stashes.create')}
        </button>
      </div>
      {failed ? <div role="alert" className="text-xs text-status-error" data-testid="git-stashes-failed">{t('gitUi.stashes.failed')}</div> : null}
      {actionFailed ? <div role="alert" className="text-xs text-status-error" data-testid="git-stash-action-failed">{t('gitUi.stashes.failed')}</div> : null}
      {stashes === null && !failed ? <div className="text-xs text-muted-foreground">{t('gitUi.history.loading')}</div> : null}
      <div className="flex flex-col gap-1">
        {(stashes ?? []).map((stash) => (
          <StashRow key={stash.ref} stash={stash} busy={busy} onApply={(drop) => void act(() => applyGitStash(directory, stash.ref, drop))} />
        ))}
        {stashes !== null && stashes.length === 0 ? <div className="text-xs text-muted-foreground">{t('gitUi.stashes.empty')}</div> : null}
      </div>
    </DialogShell>
  );
}

function StashRow({ stash, busy, onApply }: {
  stash: { ref: string; subject: string }; busy: boolean; onApply: (drop: boolean) => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 text-xs text-foreground hover:bg-interactive-hover/30" data-testid="git-stash-row">
      <span className="font-mono text-[10px] text-muted-foreground">{stash.ref}</span>
      <span className="min-w-0 flex-1 truncate" title={stash.subject}>{stash.subject}</span>
      <button type="button" disabled={busy} data-testid="git-stash-apply"
        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => onApply(false)}>
        {t('gitUi.stashes.apply')}
      </button>
      <button type="button" disabled={busy} data-testid="git-stash-drop"
        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => onApply(true)}>
        {t('gitUi.stashes.drop')}
      </button>
    </div>
  );
}

const LANE_W = 12;
const GLYPH_H = 20;

/** F6.3 commit-graph glyph: one row of the branch/merge lane graph drawn
 * from computeCommitLanes — vertical/curved edge lines plus the commit dot. */
function HistoryGraphGlyph({ row }: { row?: LaneRow }): ReactNode {
  if (!row) return <span className="w-3 shrink-0" />;
  const center = (lane: number): number => lane * LANE_W + LANE_W / 2;
  return (
    <svg width={Math.max(1, row.laneCount) * LANE_W} height={GLYPH_H} className="shrink-0" data-testid="git-history-graph">
      {row.edges.map((edge, at) => edge.from === edge.to ? (
        <line key={at} x1={center(edge.from)} y1={0} x2={center(edge.to)} y2={GLYPH_H} stroke="currentColor" strokeWidth={1} className="text-border" />
      ) : (
        <path key={at} d={`M ${center(edge.from)} 0 C ${center(edge.from)} ${GLYPH_H / 2}, ${center(edge.to)} ${GLYPH_H / 2}, ${center(edge.to)} ${GLYPH_H}`} fill="none" stroke="currentColor" strokeWidth={1} className="text-border" />
      ))}
      <circle cx={center(row.lane)} cy={GLYPH_H / 2} r={3} className="fill-primary" data-testid="git-history-node" />
    </svg>
  );
}

function DialogShell({ title, onClose, wide, children, testid }: {
  title: string;  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  testid?: string;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid={testid ?? 'git-dialog'}>
      <div className={`flex max-h-[85vh] flex-col rounded-lg border border-border/60 bg-card p-4 ${wide ? 'w-[min(56rem,90vw)]' : 'w-96'}`}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <button type="button" aria-label={t('gitUi.closeNamed', { name: title })} className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>{t('gitUi.close')}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function formatLogDate(date: number): string {
  if (!Number.isFinite(date) || date <= 0) return '';
  const parsed = new Date(date);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}
