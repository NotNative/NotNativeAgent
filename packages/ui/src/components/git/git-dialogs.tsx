// SPDX-License-Identifier: Apache-2.0
/**
 * Git dialogs (doc 06 §6.8 History + branch list, READ-ONLY v1): the
 * /api/git/log + /api/git/branches read family with a maxCount selector
 * (25/50/100) + Load more and per-commit Copy SHA; checkout/rebase/reset
 * actions need the mutate routes (P6-2b+, deferred with the §6.7 family).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  fetchGitBranches, fetchGitLog, type GitBranch,
} from '../../lib/git/api';

type GitLogEntry = NonNullable<Awaited<ReturnType<typeof fetchGitLog>>>['commits'][number];

const MAX_COUNT_STEPS = [25, 50, 100] as const;

export type GitDialogKind = 'history' | 'branches' | null;

export function GitDialogHost({ directory, onClose, dialog }: {
  directory: string;
  onClose: () => void;
  dialog: GitDialogKind;
}): ReactNode {
  if (directory.length === 0 || dialog === null) return null;
  if (dialog === 'history') return <GitHistoryDialog directory={directory} onClose={onClose} />;
  return <GitBranchesDialog directory={directory} onClose={onClose} />;
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

function GitBranchesDialog({ directory, onClose }: { directory: string; onClose: () => void }): ReactNode {
  const [branches, setBranches] = useState<GitBranch | null>(null);
  const [failed, setFailed] = useState(false);

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
    });
    return () => {
      live = false;
    };
  }, [directory]);

  return (
    <DialogShell title="Branches" onClose={onClose} testid="git-branches-dialog">
      {failed ? <div className="text-xs text-status-error" data-testid="git-branches-failed">Failed to load branches.</div> : null}
      {branches === null && !failed ? <div className="text-xs text-muted-foreground">Loading branches...</div> : null}
      {branches !== null ? (
        <div className="flex flex-col gap-2 text-xs text-foreground">
          <BranchGroup label="Local" names={branches.local} current={branches.current} />
          {branches.remote.length > 0 ? <BranchGroup label="Remote" names={branches.remote} current={null} /> : null}
          {branches.local.length === 0 && branches.remote.length === 0 ? <div className="text-muted-foreground">No branches.</div> : null}
        </div>
      ) : null}
    </DialogShell>
  );
}

function BranchGroup({ label, names, current }: { label: string; names: string[]; current: string | null }): ReactNode {
  return (
    <div data-testid={`git-branch-group-${label.toLowerCase()}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-0.5">
        {names.map((name) => (
          <div key={name} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-interactive-hover/30" data-testid="git-branch-row">
            <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
            {current === name ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Current</span> : null}
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
