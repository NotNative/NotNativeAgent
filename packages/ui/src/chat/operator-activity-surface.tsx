// SPDX-License-Identifier: Apache-2.0
/** Operator activity history, filtering, and evidence rendering. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { isNnaActivitySource, refreshActivitySnapshot } from '../sync/activity-snapshot.ts';
import type { ToolEvidence } from '../sync/activity-log.ts';
import { ACTIVITY_FILTERS, filterActivityRecords, type ActivityFilter } from './operator-activity-filter.ts';

export function ActivitySurface({ store, directory, sessionID, expanded, onReviewPath, onOpenSubagent }: {
  store: StoreApi<DirectoryStore>; directory: string; sessionID: string | null; expanded: boolean;
  onReviewPath: (path: string) => void; onOpenSubagent: (sessionID: string) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const nnaSource = isNnaActivitySource(store);
  const historyKey = `${directory}\u0000${sessionID ?? ''}`;
  const [history, setHistory] = useState<{ key: string; status: 'loading' | 'ready' | 'unavailable' } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const historyStatus = !sessionID || !nnaSource ? 'ready' : history?.key === historyKey ? history.status : 'loading';
  useEffect(() => {
    if (!nnaSource || !sessionID) return;
    let current = true;
    setHistory({ key: historyKey, status: 'loading' });
    void refreshActivitySnapshot(store, directory, sessionID, () => current)
      .then((available) => { if (current) setHistory({ key: historyKey, status: available ? 'ready' : 'unavailable' }); });
    return () => { current = false; };
  }, [directory, historyKey, nnaSource, refreshRevision, store, sessionID]);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [unseen, setUnseen] = useState(0);
  const viewport = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const previous = useRef({ key: '', ids: new Set<string>() });
  const records = useMemo(() => filterActivityRecords(snapshot.activity, sessionID, filter),
  [snapshot.activity, sessionID, filter]);
  const key = `${sessionID ?? ''}\u0000${filter}`;
  useEffect(() => {
    const viewportNode = viewport.current;
    if (previous.current.key !== key) {
      previous.current = { key, ids: new Set(records.map((record) => record.id)) };
      following.current = true;
      setUnseen(0);
      if (viewportNode) viewportNode.scrollTop = viewportNode.scrollHeight;
      return;
    }
    const added = records.filter((record) => !previous.current.ids.has(record.id)).length;
    previous.current.ids = new Set(records.map((record) => record.id));
    if (following.current) {
      if (viewportNode) viewportNode.scrollTop = viewportNode.scrollHeight;
      setUnseen(0);
    } else if (added > 0) setUnseen((count) => count + added);
  }, [key, records]);
  return <section className="flex h-full min-h-0 flex-col" data-testid="operator-activity">
    <header className="shrink-0 border-b border-white/10 p-3 pb-2">
      <div className={expanded ? 'mx-auto w-full max-w-5xl' : 'w-full'} data-testid="activity-reading-column">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-medium text-neutral-200">Activity log</h2><span className="text-[10px] text-neutral-500">{records.length} events</span></div>
        {nnaSource && historyStatus === 'loading' && records.length > 0 ? <p role="status" className="mb-2 text-[10px] text-neutral-400">Loading saved activity; showing live evidence so far.</p> : null}
        {nnaSource && historyStatus === 'unavailable' ? <div role="status" className="mb-2 flex items-center gap-2 text-[10px] text-amber-300">
          <span>Saved activity unavailable; live evidence may be incomplete.</span>
          <button type="button" className="underline" onClick={() => setRefreshRevision((value) => value + 1)}>Retry</button>
        </div> : null}
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter activity">
          {ACTIVITY_FILTERS.map((option) => <button key={option.id} type="button" aria-pressed={filter === option.id}
            className={`rounded px-1.5 py-1 text-[10px] ${filter === option.id ? 'bg-white/15 text-white' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => setFilter(option.id)}>{option.label}</button>)}
        </div>
      </div>
    </header>
    <ol ref={viewport} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="activity-rows"
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
        if (following.current) setUnseen(0);
      }}>
      {records.length === 0 ? <li className={`${expanded ? 'mx-auto w-full max-w-5xl' : ''} text-[11px] text-neutral-500`}>{!sessionID ? 'Select a session to watch its activity.'
        : historyStatus === 'loading' ? 'Loading saved activity…'
        : historyStatus === 'unavailable' ? 'Saved activity could not be loaded. Live events will still appear here.'
        : filter === 'all' ? 'No recorded activity for this session yet. Conversation messages remain in the transcript.'
        : filter === 'attention' ? 'No activity requiring input has been received for this session.'
        : filter === 'files' ? 'No recorded completed file changes for this session.'
        : filter === 'last-turn' ? 'No turn-correlated activity is available for the latest turn.'
        : `No ${filter === 'failed' ? 'failed' : filter} activity evidence has been received for this session.`}</li>
        : records.map((record) => <li key={record.id} className={`${expanded ? 'mx-auto w-full max-w-5xl ' : ''}rounded border p-2 text-[11px] ${record.status === 'failed' ? 'border-red-500/40 bg-red-950/20' : record.status === 'attention' ? 'border-amber-500/40 bg-amber-950/20' : 'border-white/10 bg-neutral-900/40'}`}><div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-neutral-500"><span>{record.kind}</span><time className="ml-auto min-w-0 break-words text-right" dateTime={new Date(record.time).toISOString()} data-testid="activity-timestamp">{new Date(record.time).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><span className={record.status === 'failed' ? 'text-red-300' : record.status === 'attention' || record.status === 'redacted' ? 'text-amber-300' : ''}>{record.status === 'attention' ? 'needs input' : record.status}</span></div><p className="mt-1 break-words text-neutral-300">{record.summary}</p>
          {record.toolEvidence ? <ToolEvidenceDetail evidence={record.toolEvidence} /> : null}
          {record.kind === 'subagent' && record.childSessionID
            && snapshot.session.some((session) => session.id === record.childSessionID && session.parentID === record.sessionID)
            ? <button type="button" className="mt-1 text-sky-300 hover:underline"
              onClick={() => onOpenSubagent(record.childSessionID!)}>Open subagent transcript</button> : null}
          {record.status === 'completed' && record.toolEvidence?.reviewPath
            && record.toolEvidence.reviewDirectory === directory ? <button type="button"
            className="mt-1 text-sky-300 hover:underline" onClick={() => onReviewPath(record.toolEvidence!.reviewPath!)}>
            Review file in Changes</button> : null}
          {(record.evidenceMessageID || record.toolEvidence?.turnRequestID)
            && snapshot.message[record.sessionID]?.some((message) => message.id === (record.evidenceMessageID || record.toolEvidence?.turnRequestID))
            ? <button type="button" className="mt-1 text-sky-300 hover:underline" onClick={() => {
              const anchor = `message-${record.evidenceMessageID || record.toolEvidence?.turnRequestID}`;
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
              window.location.hash = `#${anchor}`;
              document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
            }}>View prompt</button> : null}</li>)}
    </ol>
    {unseen > 0 ? <button type="button" className={`m-2 shrink-0 rounded border border-white/15 bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 ${expanded ? 'self-center' : ''}`} data-testid="activity-jump-live"
      onClick={() => { following.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; setUnseen(0); }}>↓ {unseen} new {unseen === 1 ? 'event' : 'events'} · Jump to live</button> : null}
  </section>;
}

function ToolEvidenceDetail({ evidence }: { evidence: ToolEvidence }): ReactNode {
  const rows = [
    ['Target', evidence.target], ['Effect', evidence.effect], ['Reason', evidence.reasonCode],
    ['Elapsed', evidence.elapsedMs === undefined ? undefined : `${evidence.elapsedMs} ms`],
    ['Exit code', evidence.exitCode === undefined ? undefined : String(evidence.exitCode)],
  ].filter((row): row is [string, string] => row[1] !== undefined);
  if (rows.length === 0) return null;
  return <details className="mt-1 rounded border border-white/10 px-2 py-1" data-testid="activity-tool-evidence">
    <summary className="cursor-pointer text-sky-300">Tool evidence</summary>
    <dl className="mt-1 space-y-1">{rows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-2">
      <dt className="text-neutral-500">{label}</dt><dd className="max-w-full break-all text-neutral-300">{value}</dd>
    </div>)}</dl>
  </details>;
}
