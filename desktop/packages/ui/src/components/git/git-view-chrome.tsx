// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { GitStatus } from '../../lib/git/api';
import { useI18n } from '../../lib/i18n/context.tsx';

export function StatusFailure({ onRetry }: { onRetry: () => void }): ReactNode {
  const { t } = useI18n();
  return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground" data-testid="git-status-error" role="status">
    <span>{t('gitUi.gitStatusLoadFailed')}</span>
    <button type="button" className="rounded border border-border/60 px-3 py-1 text-xs text-foreground hover:bg-interactive-hover/30" onClick={onRetry}>{t('gitUi.retry')}</button>
  </div>;
}

export function BranchTracking({ status }: { status: GitStatus }): ReactNode {
  const { t } = useI18n();
  if (status.upstream === undefined || status.branch === null) return null;
  const label = status.upstream === null ? t('gitUi.noUpstream') : status.upstreamGone ? t('gitUi.upstreamMissing')
    : status.trackingAhead === 0 && status.trackingBehind === 0 ? t('gitUi.upToDate')
    : t('gitUi.aheadBehind', { ahead: status.trackingAhead, behind: status.trackingBehind });
  return <span className={`rounded-full px-2 py-0.5 text-[10px] ${status.upstreamGone ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-muted-foreground'}`}
    title={status.upstream ?? t('gitUi.noUpstreamTitle')} data-testid="git-tracking">{label}</span>;
}

export function symbolColorOf(symbol: string): string {
  if (symbol === 'A') return 'var(--status-success)';
  if (symbol === 'D') return 'var(--status-error)';
  if (symbol === 'M') return 'var(--status-warning)';
  return 'var(--status-info)';
}

export function gitError(error: unknown, fallback = 'Git operation failed'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
