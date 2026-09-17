// SPDX-License-Identifier: Apache-2.0
/**
 * GitView (doc 06 §6, P6-2 core subset): repository workbench showing the
 * changes tree (staged/unstaged groups with stage-all buttons), the commit
 * section (message + Commit/Commit & sync busy flow), reverted dialogs,
 * branch info + clean empty state. Dialogs beyond these (history/graph/
 * stashes/conflict/update-branch) are registered for P6-2b with the
 * §6.7-§6.9 route family; PR chip = P11.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useGitStore, groupedStatusFiles, scheduleGitReconcile } from '../../lib/git/store';
import {
  commitChanges, discardGitFiles, fetchGitBranches, fetchGitStatus, stageGitFiles, unstageGitFiles,
  statusSymbol, type GitStatus, type GitStatusFile,
} from '../../lib/git/api';
import { useI18n } from '../I18nProvider.tsx';

export function GitView({ directory }: { directory: string }): ReactNode {
  const { t } = useI18n();
  void t;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'' | 'commit' | 'stage' | 'revert'>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRevert, setConfirmRevert] = useState<GitStatusFile | null>(null);
  const statusRef = useRef<GitStatus | null>(null);
  statusRef.current = status;
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const refreshAll = useGitStore((state) => state.ensureAll);
  const bumpIndexRevision = useGitStore((state) => state.bumpIndexRevision);
  const moveOptimistic = useGitStore((state) => state.moveStatusPathsOptimistically);
  const restore = useGitStore((state) => state.restoreStatus);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const next = await ensureStatus(directory, 'light');
      setStatus(next);
      const branches = await fetchGitBranches(directory);
      setBranch(branches?.current ?? null);
      setLoading(false);
    })();
  }, [directory, ensureStatus]);

  const grouped = status !== null ? groupedStatusFiles(status) : { staged: [], working: [] };
  const staged = grouped.staged.filter((entry) => isStaged(entry));
  const working = grouped.working.filter((entry) => !staged.includes(entry));

  const withBusy = useCallback(async (kind: 'commit' | 'stage' | 'revert', run: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    try {
      await run();
    } finally {
      setBusy('');
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await ensureStatus(directory, 'full');
    setStatus(next);
    bumpIndexRevision(directory);
    scheduleGitReconcile(directory);
  }, [directory, ensureStatus, bumpIndexRevision]);

  const stage = useCallback((paths: string[], direction: 'stage' | 'unstage'): void => {
    void withBusy('stage', async () => {
      const before = statusRef.current;
      try {
        moveOptimistic(directory, paths, direction);
        if (direction === 'stage') await stageGitFiles(directory, paths);
        else await unstageGitFiles(directory, paths);
        bumpIndexRevision(directory);
        scheduleGitReconcile(directory);
        setStatus(await ensureStatus(directory, 'full'));
      } catch {
        if (before !== null) restore(directory, before);
        toast.error(direction === 'stage' ? 'Failed to stage file' : 'Failed to unstage file');
      }
    });
  }, [directory, moveOptimistic, restore, bumpIndexRevision, ensureStatus, withBusy]);

  const revert = useCallback((paths: string[]): void => {
    void withBusy('revert', async () => {
      try {
        await discardGitFiles(directory, paths);
        refresh().catch(() => undefined);
      } catch {
        toast.error('Failed to revert file');
      }
    });
  }, [directory, refresh, withBusy]);

  const commit = useCallback((sync: boolean): void => {
    void withBusy('commit', async () => {
      if (message.trim().length === 0) {
        toast.error('Enter a commit message');
        return;
      }
      const result = await commitChanges(directory, message);
      if ('error' in result) {
        toast.error('Commit failed');
        return;
      }
      toast.success('Commit created');
      setMessage('');
      await refresh();
      if (sync) toast.message('Commit created — push lands with P11 routes');
    });
  }, [directory, message, refresh, withBusy]);

  if (loading) {
    return <Centered label="Checking repository..." data-testid="git-view-loading" />;
  }
  if (status === null || status.isGitRepository === false) {
    return <Centered label="Not a git repository. Use the Git tab to initialize or change directories." data-testid="git-empty" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-2" data-testid="git-view">
      <header className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
        <span className="text-xs font-medium text-foreground">{branch ?? 'Detached HEAD'}</span>
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Current</span>
        <span className="ml-auto text-[10px] text-muted-foreground">Graph · Stashes — P6-2b dialogs</span>
      </header>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Section title="Staged" accent onStageAll={working.length > 0 ? () => stage(working.map((entry) => entry.path), 'stage') : undefined} onUnstageAll={staged.length > 0 ? () => stage(staged.map((entry) => entry.path), 'unstage') : undefined}>
            {staged.map((entry) => <FileRow key={entry.path} entry={entry} staged selected={selected.has(entry.path)} onToggle={() => toggleSelect(entry.path)} onStageToggle={() => stage([entry.path], 'unstage')} onRevert={() => setConfirmRevert(entry)} />)}
            {staged.length === 0 ? <EmptyLine label="No staged changes" /> : null}
          </Section>
          <Section title="Changes">
            {working.map((entry) => <FileRow key={entry.path} entry={entry} staged={false} selected={selected.has(entry.path)} onToggle={() => toggleSelect(entry.path)} onStageToggle={() => stage([entry.path], 'stage')} onRevert={() => setConfirmRevert(entry)} />)}
            {working.length === 0 ? <EmptyLine label="No changes" /> : null}
          </Section>
        </div>
        <aside className="flex w-72 shrink-0 flex-col gap-3">
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
      {confirmRevert !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="git-revert-dialog">
          <div className="w-80 rounded-lg border border-border/60 bg-card p-4">
            <div className="text-sm font-medium text-foreground">Revert changes</div>
            <div className="mt-1 text-xs text-muted-foreground">{`Are you sure you want to revert ${confirmRevert.path}? This cannot be undone.`}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setConfirmRevert(null)}>Cancel</button>
              <button type="button" className="rounded bg-status-error/20 px-3 py-1 text-xs text-status-error" onClick={() => {
                setConfirmRevert(null);
                revert([confirmRevert.path]);
              }}>Revert</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  function toggleSelect(path: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
}

function isStaged(entry: GitStatusFile): boolean {
  return entry.index !== '' && entry.index !== ' ' && entry.index !== '?';
}

function Centered({ label, ...rest }: { label: string } & Record<string, string>): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground" {...rest}>
      {label}
    </div>
  );
}

function Section({
  title, accent, onStageAll, onUnstageAll, children,
}: {
  title: string;
  accent?: boolean;
  onStageAll?: (() => void) | undefined;
  onUnstageAll?: (() => void) | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={`rounded-lg border p-2 ${accent ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-card/40'}`}>
      <header className="mb-1 flex items-center gap-2 px-1">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${accent ? 'text-primary' : 'text-muted-foreground'}`}>{title}</span>
        {onStageAll ? <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-success hover:text-success" onClick={onStageAll}>Stage all changes</button> : null}
        {onUnstageAll ? <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onUnstageAll}>Unstage all changes</button> : null}
      </header>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function FileRow({
  entry, staged, selected, onToggle, onStageToggle, onRevert,
}: { entry: GitStatusFile; staged: boolean; selected: boolean; onToggle: () => void; onStageToggle: () => void; onRevert: () => void }): ReactNode {
  const symbol = statusSymbol(entry);
  return (
    <div className="flex min-h-8 items-center gap-2 rounded px-2 hover:bg-interactive-hover/30">
      <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--primary)]" checked={selected} onChange={onToggle} aria-label={`Select ${entry.path}`} />
      <span className="inline-block w-3 text-center font-mono text-xs" style={{ color: symbolColorOf(symbol) }}>{symbol}</span>
      <button type="button" className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:text-primary" title={entry.path} onClick={onStageToggle}>
        {entry.path}
      </button>
      <button type="button" aria-label={`Revert changes in ${entry.path}`} className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-status-error" onClick={onRevert}>
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
