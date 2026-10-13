// SPDX-License-Identifier: Apache-2.0
/**
 * Integrations surfaces (W-53): read-only GitHub open-PR list and Linear
 * issue list for the current directory. Account setup is optional — the
 * panels render the server's typed fail-closed code instead of pretending
 * an empty list is a healthy state.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { getApiBaseUrl } from '../../lib/runtime-url.ts';

type PullSummary = { number: number; title: string; state: 'open' | 'draft'; headRef: string; baseRef: string; url: string; updatedAt: string };
type IssueSummary = { id: string; identifier: string; title: string; state: string; assignee: string | null; url: string; updatedAt: string };

type Feed<T> = { state: 'idle' | 'busy' | 'ready'; items: T[] } | { state: 'failed'; code: string };

export function PullRequestsPanel({ directory }: { directory: string }): ReactNode {
  const [feed, setFeed] = useState<Feed<PullSummary>>({ state: 'idle', items: [] });
  const load = useCallback(async () => {
    setFeed({ state: 'busy', items: [] });
    try {
      const response = await runtimeFetch(`${getApiBaseUrl()}/api/integrations/github/pulls?directory=${encodeURIComponent(directory)}`, { signal: AbortSignal.timeout(15_000) });
      const body = (await response.json()) as { pulls?: PullSummary[]; code?: string };
      if (body.pulls !== undefined) setFeed({ state: 'ready', items: body.pulls });
      else setFeed({ state: 'failed', code: body.code ?? 'github-unavailable' });
    } catch { setFeed({ state: 'failed', code: 'github-unavailable' }); }
  }, [directory]);
  return (
    <div className="rounded border border-border/60 p-2" data-testid="pull-requests-panel">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Pull requests</span>
        <button type="button" data-testid="pull-requests-refresh" disabled={feed.state === 'busy'}
          className="rounded border border-white/15 px-2 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
          onClick={() => void load()}>Refresh</button>
      </div>
      {feed.state === 'failed' ? <p className="mt-1 text-[11px] text-amber-300" role="alert" data-testid="pull-requests-failure">GitHub unavailable ({feed.code}) — account setup is optional; the list stays closed until the transport works.</p> : null}
      {feed.state === 'ready' && feed.items.length === 0 ? <p className="mt-1 text-[11px] text-neutral-500">No open pull requests.</p> : null}
      <ul className="mt-1 space-y-1">
        {feed.state === 'ready' ? feed.items.map((pull) => (
          <li key={pull.number} className="text-[11px] text-neutral-300" data-testid={`pull-${pull.number}`}>
            #{pull.number} {pull.title} <span className="text-neutral-500">{pull.state} · {pull.headRef} → {pull.baseRef}</span>
          </li>
        )) : null}
      </ul>
    </div>
  );
}

export function LinearIssuesPanel(): ReactNode {  const [feed, setFeed] = useState<Feed<IssueSummary>>({ state: 'idle', items: [] });
  const load = useCallback(async () => {
    setFeed({ state: 'busy', items: [] });
    try {
      const response = await runtimeFetch(`${getApiBaseUrl()}/api/integrations/linear/issues`, { signal: AbortSignal.timeout(15_000) });
      const body = (await response.json()) as { issues?: IssueSummary[]; code?: string };
      if (body.issues !== undefined) setFeed({ state: 'ready', items: body.issues });
      else setFeed({ state: 'failed', code: body.code ?? 'linear-unavailable' });
    } catch { setFeed({ state: 'failed', code: 'linear-unavailable' }); }
  }, []);
  return (
    <div className="rounded border border-border/60 p-2" data-testid="linear-issues-panel">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Linear issues</span>
        <button type="button" data-testid="linear-issues-refresh" disabled={feed.state === 'busy'}
          className="rounded border border-white/15 px-2 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
          onClick={() => void load()}>Refresh</button>
      </div>
      {feed.state === 'failed' ? <p className="mt-1 text-[11px] text-amber-300" role="alert" data-testid="linear-issues-failure">Linear unavailable ({feed.code}){feed.code === 'linear-unconfigured' ? ' — setup is optional; add a key to open the list.' : '.'}</p> : null}
      {feed.state === 'ready' && feed.items.length === 0 ? <p className="mt-1 text-[11px] text-neutral-500">No open issues.</p> : null}
      <ul className="mt-1 space-y-1">
        {feed.state === 'ready' ? feed.items.map((issue) => (
          <li key={issue.id} className="text-[11px] text-neutral-300" data-testid={`issue-${issue.identifier}`}>
            {issue.identifier} {issue.title} <span className="text-neutral-500">{issue.state}{issue.assignee ? ` · ${issue.assignee}` : ''}</span>
          </li>
        )) : null}
      </ul>
    </div>
  );
}

/** Both W-53 surfaces side by side, visible-gated by the caller. */
export function IntegrationsStrip({ directory }: { directory: string }): ReactNode {
  return (
    <div className="flex flex-wrap gap-3" data-testid="git-integrations">
      <div className="min-w-[240px] flex-1"><PullRequestsPanel directory={directory} /></div>
      <div className="min-w-[240px] flex-1"><LinearIssuesPanel /></div>
    </div>
  );
}
