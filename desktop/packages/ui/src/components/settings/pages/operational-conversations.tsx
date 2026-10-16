// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { harnessClient, type HarnessSession } from '../../../lib/nnd/client.ts';
import { useGlobalSessionsStore } from '../../../sync/global-stores.ts';
import { downloadSessionMarkdown } from '../../../chat/session-export.ts';
import { useNativeObservation, nativeObservationScope } from './use-native-observation.ts';
import { conversationTranscript, readDataConversations } from './conversation-data-model.ts';

export function ConversationData() {
  const state = useNativeObservation(readDataConversations);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useState(''), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const act = async (session: HarnessSession, action: 'archive' | 'restore' | 'export') => {
    if (active.current || !state.ready) return;
    const controller = new AbortController(); active.current = controller;
    const scope = nativeObservationScope(), current = () => !controller.signal.aborted && scope === nativeObservationScope();
    setBusy(true); setError(''); setOutcome('');
    try {
      if (action === 'export') {
        const markdown = await conversationTranscript(session, controller.signal);
        if (current()) { downloadSessionMarkdown(`${session.title.replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'conversation'}.md`, markdown);
          setOutcome('Complete retrieved transcript prepared for download. Tool payloads and authority records are excluded.'); }
      } else {
        const archived = action === 'restore' ? 0 : Date.now();
        const result = await harnessClient.updateSession(session.id, { time: { archived } }, { directory: session.directory });
        if (!current()) return;
        if (result.error || result.data?.id !== session.id || (result.data.time?.archived ?? 0) !== archived) throw new Error('NNA did not confirm the archive change. Refresh before retrying.');
        setOutcome(action === 'restore' ? 'Conversation restored to its workspace.' : 'Conversation archived with its subtasks.');
        await state.reload(); if (current()) void useGlobalSessionsStore.getState().loadSessions();
      }
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Conversation operation failed.'); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  };
  const rows = (state.data ?? []).filter(row => (!query.trim() || `${row.title} ${row.directory}`.toLowerCase().includes(query.trim().toLowerCase()))
    && (filter === 'all' || (filter === 'archived') === Boolean(row.time.archived)));
  return <div className="space-y-4 text-xs">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Conversations and archives</h3>
      <button type="button" disabled={state.busy || busy || !state.ready} onClick={() => { void state.reload(); }}>Refresh conversations</button></div>
    <p>Folders remain managed in the workspace sidebar, including the permanent default workspace. Archive preserves workspace ownership and subtasks.
      Export reads the selected transcript, up to 5,000 messages / 8 MiB; it refuses partial or changed reads.</p>
    <p>Transcript exports include user and assistant text, which can contain personal information. They exclude tool payloads and cannot restore execution authority.
      Usage and measured/estimated context are shown in each conversation’s context panel.</p>
    <div className="flex flex-wrap gap-3"><input aria-label="Search data conversations" placeholder="Search title or workspace…" value={query}
      onChange={event => { setQuery(event.target.value); setLimit(50); }} className="rounded border border-border bg-background p-2" />
      <select aria-label="Conversation archive filter" value={filter} onChange={event => { setFilter(event.target.value); setLimit(50); }} className="rounded border border-border bg-background p-2">
        <option value="all">All conversations</option><option value="active">Active only</option><option value="archived">Archived only</option></select></div>
    {state.busy ? <p role="status">Reading conversations…</p> : null}
    {state.error || error ? <p role="alert">{error || state.error}</p> : null}
    {outcome ? <p role="status">{outcome}</p> : null}
    {state.data && !rows.length ? <p>No matching conversations.</p> : null}
    <ul className="space-y-3">{rows.slice(0, limit).map(row => <li key={row.id} className="rounded-lg border border-border p-3" data-testid="data-conversation">
      <h4 className="text-sm font-medium">{row.title}</h4><p className="break-all text-muted-foreground">{row.directory} · {row.time.archived ? 'Archived' : 'Active'}</p>
      <div className="mt-2 flex gap-3"><button type="button" disabled={busy || !state.ready} onClick={() => { void act(row, row.time.archived ? 'restore' : 'archive'); }}>{row.time.archived ? 'Restore' : 'Archive'}</button>
        <button type="button" disabled={busy || !state.ready} onClick={() => { void act(row, 'export'); }}>Export transcript</button></div>
    </li>)}</ul>
    {rows.length > limit ? <button type="button" onClick={() => setLimit(previous => Math.min(1000, previous + 50))}>Show more conversations</button> : null}
  </div>;
}
