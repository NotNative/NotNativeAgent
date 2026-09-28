// SPDX-License-Identifier: Apache-2.0
/**
 * Git dialogs (doc 06 §6.8 History + branch list): the
 * /api/git/log + /api/git/branches read family with a maxCount selector
 * (25/50/100) + Load more and per-commit Copy SHA; checkout/rebase/reset
 * local checkout action uses an explicit clean-worktree server preflight;
 * remote tracking, creation, and other branch mutations remain separate.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchGitBranches, fetchGitLog, type GitBranch,
} from '../../lib/git/api';

type GitLogEntry = NonNullable<Awaited<ReturnType<typeof fetchGitLog>>>['commits'][number];

const MAX_COUNT_STEPS = [25, 50, 100] as const;

export type GitDialogKind = 'history' | 'branches' | null;

export function GitDialogHost({ directory, onClose, dialog, onSwitchBranch, switchingDisabled = false }: {
  directory: string;
  onClose: () => void;
  dialog: GitDialogKind;
  onSwitchBranch?: (branch: string, expectedBranch: string, create?: boolean) => Promise<void>;
  switchingDisabled?: boolean;
}): ReactNode {
  if (directory.length === 0 || dialog === null) return null;
  if (dialog === 'history') return <GitHistoryDialog directory={directory} onClose={onClose} />;
  return <GitBranchesDialog key={directory} directory={directory} onClose={onClose} onSwitchBranch={onSwitchBranch} switchingDisabled={switchingDisabled} />;
}

function GitHistoryDialog({ directory, onClose }: { directory: string; onClose: () => void }): ReactNode {
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null);
  const [maxCount, setMaxCount] = useState<number>(50);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void fetchGitLog(directory, maxCount).then((result) => {
      if (!live) return;
      if (result === null) {
        setFailed(true);
        return;
      }
      setCommits(Array.isArray(result.commits) ? result.commits : []);
    });
    return () => {
      live = false;
    };
  }, [directory, maxCount]);

  const copySha = useCallback(async (hash: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(hash);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setFailed(true);
    }
    return undefined;
  }, []);

  return (
    <DialogShell title="Commit history" wide onClose={onClose} testid="git-history-dialog">
      <div className="mb-2 flex items-center gap-2" role="group" aria-label="Log size">
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
        {commits !== null && commits.length >= maxCount ? (
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="git-history-load-more" onClick={() => setMaxCount(Math.min(500, maxCount + 50))}>Load more</button>
        ) : null}
      </div>
      {failed ? <div className="text-xs text-status-error" data-testid="git-history-failed">Failed to load log.</div> : null}
      {commits === null && !failed ? <div className="text-xs text-muted-foreground">Loading history...</div> : null}
      <div className="flex flex-col gap-1">
        {(commits ?? []).map((commit) => (
          <div key={commit.hash} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-foreground hover:bg-interactive-hover/30" data-testid="git-history-row">
            <span className="font-mono text-[10px] text-muted-foreground">{commit.hash.slice(0, 8)}</span>
            <span className="min-w-0 flex-1 truncate" title={commit.subject}>{commit.subject}</span>
            <span className="text-[10px] text-muted-foreground">{commit.author}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">{formatLogDate(commit.date)}</span>
            <button
              type="button"
              aria-label={`Copy commit SHA ${commit.hash}`}
              data-testid="git-history-copy"
              className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void copySha(commit.hash)}
            >
              {copied === commit.hash ? 'Copied' : 'Copy SHA'}
            </button>
          </div>
        ))}
        {commits !== null && commits.length === 0 ? <div className="text-xs text-muted-foreground">No commits yet.</div> : null}
      </div>
    </DialogShell>
  );
}

function GitBranchesDialog({ directory, onClose, onSwitchBranch, switchingDisabled }: {
  directory: string; onClose: () => void; onSwitchBranch?: (branch: string, expectedBranch: string, create?: boolean) => Promise<void>; switchingDisabled: boolean;
}): ReactNode {
  const [branches, setBranches] = useState<GitBranch | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState('');
  const live = useRef(true);

  useEffect(() => () => { live.current = false; }, []);

  useEffect(() => {
    let live = true;
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
    catch (error) { if (live.current) setSwitchError(error instanceof Error ? error.message : 'Could not change branch'); }
    finally { if (live.current) setPending(null); }
  };

  const search = query.trim().toLocaleLowerCase();
  const matches = (name: string): boolean => name.toLocaleLowerCase().includes(search);

  return (
    <DialogShell title="Branches" onClose={onClose} testid="git-branches-dialog">
      {failed ? <div className="text-xs text-status-error" data-testid="git-branches-failed">Failed to load branches.</div> : null}
      {branches === null && !failed ? <div className="text-xs text-muted-foreground">Loading branches...</div> : null}
      {branches !== null ? (
        <div className="flex flex-col gap-2 text-xs text-foreground">
          <input type="search" aria-label="Search branches" placeholder="Search branches..." value={query}
            onChange={(event) => setQuery(event.target.value)} className="rounded border border-border/60 bg-transparent px-2 py-1 text-xs outline-none" />
          {switchError ? <div role="alert" className="text-status-error" data-testid="git-branch-switch-error">{switchError}</div> : null}
          <BranchGroup label="Local" names={branches.local.filter(matches)} current={branches.current}
            onSwitch={branches.current ? (branch) => { void runBranchAction(branch); } : undefined} switchingDisabled={switchingDisabled || pending !== null} pending={pending} />
          {branches.remote.some(matches) ? <BranchGroup label="Remote" names={branches.remote.filter(matches)} current={null} /> : null}
          {branches.local.length === 0 && branches.remote.length === 0 ? <div className="text-muted-foreground">No branches.</div> : null}
          {search && !branches.local.some(matches) && !branches.remote.some(matches) ? <div className="text-muted-foreground">No matching branches.</div> : null}
          {branches.current === null ? <div className="text-muted-foreground">Check out a local branch in Git before switching here.</div> : null}
          {branches.current !== null && onSwitchBranch ? <form className="mt-2 flex gap-2 border-t border-border/60 pt-3" onSubmit={(event) => {
            event.preventDefault();
            const name = newBranch.trim();
            if (name) void runBranchAction(name, true);
          }}>
            <input type="text" aria-label="New local branch name" placeholder="Create new branch..." value={newBranch} maxLength={200}
              onChange={(event) => setNewBranch(event.target.value)} className="min-w-0 flex-1 rounded border border-border/60 bg-transparent px-2 py-1 text-xs outline-none" />
            <button type="submit" disabled={switchingDisabled || pending !== null || newBranch.trim().length === 0}
              className="rounded border border-border/60 px-2 py-1 text-xs disabled:opacity-40" data-testid="git-create-branch">
              {pending === newBranch.trim() ? 'Creating...' : 'Create & switch'}
            </button>
          </form> : null}
        </div>
      ) : null}
    </DialogShell>
  );
}

function BranchGroup({ label, names, current, onSwitch, switchingDisabled = false, pending = null }: {
  label: string; names: string[]; current: string | null; onSwitch?: (branch: string) => void; switchingDisabled?: boolean; pending?: string | null;
}): ReactNode {
  return (
    <div data-testid={`git-branch-group-${label.toLowerCase()}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-0.5">
        {names.map((name) => (
          <div key={name} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-interactive-hover/30" data-testid="git-branch-row">
            <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
            {current === name ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Current</span> : null}
            {onSwitch && current !== name ? <button type="button" disabled={switchingDisabled}
              aria-label={`Switch to ${name}`} className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => onSwitch(name)}>{pending === name ? 'Switching...' : 'Switch'}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function DialogShell({ title, onClose, wide, children, testid }: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  testid?: string;
}): ReactNode {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid={testid ?? 'git-dialog'}>
      <div className={`flex max-h-[85vh] flex-col rounded-lg border border-border/60 bg-card p-4 ${wide ? 'w-[min(56rem,90vw)]' : 'w-96'}`}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <button type="button" aria-label={`Close ${title}`} className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
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
