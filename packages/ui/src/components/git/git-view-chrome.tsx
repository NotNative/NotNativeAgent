// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { GitStatus } from '../../lib/git/api';

export function StatusFailure({ onRetry }: { onRetry: () => void }): ReactNode {
  return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground" data-testid="git-status-error" role="status">
    <span>Could not load Git status for this workspace.</span>
    <button type="button" className="rounded border border-border/60 px-3 py-1 text-xs text-foreground hover:bg-interactive-hover/30" onClick={onRetry}>Retry</button>
  </div>;
}

export function BranchTracking({ status }: { status: GitStatus }): ReactNode {
  if (status.upstream === undefined || status.branch === null) return null;
  const label = status.upstream === null ? 'No upstream' : status.upstreamGone ? 'Upstream missing'
    : status.trackingAhead === 0 && status.trackingBehind === 0 ? 'Up to date'
    : `↑${status.trackingAhead} ↓${status.trackingBehind}`;
  return <span className={`rounded-full px-2 py-0.5 text-[10px] ${status.upstreamGone ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-muted-foreground'}`}
    title={status.upstream ?? 'No upstream configured'} data-testid="git-tracking">{label}</span>;
}

export function symbolColorOf(symbol: string): string {
  if (symbol === 'A') return 'var(--status-success)';
  if (symbol === 'D') return 'var(--status-error)';
  if (symbol === 'M') return 'var(--status-warning)';
  return 'var(--status-info)';
}

export function gitError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Git operation failed';
}
