// SPDX-License-Identifier: Apache-2.0
/** Scoped display/edit surface for agent-owned memory; creates belong to the tool. */
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { deleteAgentMemory, listAgentMemory, updateAgentMemory, AgentMemoryDisabledError, AgentMemoryRequestError,
  usableMemory as usableMemoryEntry, type AgentMemoryEntry, type AgentMemoryOverview, type AgentMemoryScope,
  type AgentMemoryType } from '../lib/agent-memory-api.ts';

export interface ContextMemoryDraft {
  scope: AgentMemoryScope; memoryId: string; title: string; body: string; type: AgentMemoryType;
}

export function ContextMemory({ projectId, visible, query = '', retainedDraft, onDraftChange }: {
  projectId: string; visible: boolean; query?: string;
  retainedDraft?: ContextMemoryDraft; onDraftChange?: (projectId: string, draft: ContextMemoryDraft) => void;
}): ReactNode {
  const [overview, setOverview] = useState<AgentMemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ContextMemoryDraft>(
    () => retainedDraft ?? { scope: 'project', memoryId: '', title: '', body: '', type: 'fact' });
  const [revision, setRevision] = useState(0);

  useEffect(() => { onDraftChange?.(projectId, draft); }, [draft, onDraftChange, projectId]);
  function refresh(): void { setRevision((current) => current + 1); }
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setBusy(false); setError(''); setDisabled(false);
    void listAgentMemory(projectId).then((value) => {
      if (active) { setOverview(value); setLoading(false); }
    }).catch((caught: unknown) => {
      if (!active) return;
      setDisabled(caught instanceof AgentMemoryDisabledError);
      setError(caught instanceof AgentMemoryDisabledError ? 'Agent memory is disabled.'
        : caught instanceof AgentMemoryRequestError ? caught.detail
        : 'Memory could not be loaded.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, visible, revision]);
  const entries = overview?.[draft.scope] ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const selected = entries.find((entry) => usableMemoryEntry(entry) && entry.id === draft.memoryId);

  function select(scope: AgentMemoryScope, entry: AgentMemoryEntry): void {
    setDraft({ scope, memoryId: entry.id, title: entry.title, body: entry.body, type: entry.type });
  }

  async function save(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      const committed = await updateAgentMemory(draft.scope === 'project' ? projectId : undefined, draft.memoryId,
        { title: draft.title, body: draft.body, type: draft.type });
      setOverview((current) => current ? { ...current,
        [draft.scope]: committed.entries.filter(usableMemoryEntry) } : null);
      setDraft((state) => ({ ...state, title: committed.entry.title, body: committed.entry.body, type: committed.entry.type }));
    } catch (caught: unknown) {
      setError(caught instanceof AgentMemoryRequestError ? caught.detail : 'Memory edit failed. The draft is still here.');
    } finally { setBusy(false); }
  }

  async function remove(memoryId: string, scope: AgentMemoryScope): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const committed = await deleteAgentMemory(scope === 'project' ? projectId : undefined, memoryId);
      setOverview((current) => current ? { ...current, [scope]: current[scope].filter((entry) => entry.id !== committed.memoryId) } : current);
      setDraft((current) => {
        return scope === current.scope && memoryId === current.memoryId
          ? { scope, memoryId: '', title: '', body: '', type: current.type }
          : current;
      });
    } catch (caught: unknown) {
      setError(caught instanceof AgentMemoryRequestError ? caught.detail : 'Memory could not be deleted.');
    } finally { setBusy(false); }
  }

  return <section className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="agent-memory-panel">
    <header className="flex items-center gap-2 text-[10px] text-neutral-400">
      <span>Agent-owned memory — separate from user notes</span>
      <button type="button" className="ml-auto underline" disabled={busy} onClick={refresh}>Refresh</button>
    </header>
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
    {disabled ? null : <>
      <nav className="flex gap-1 text-xs" aria-label="Agent memory scope">
        {(['project', 'global'] as const).map((scope) => <button key={scope} type="button" disabled={busy}
          className={`rounded px-2 py-1 text-[10px] ${draft.scope === scope ? 'bg-white/10 text-white' : 'text-neutral-500'}`}
          onClick={() => setDraft((current) => ({ scope, memoryId: '', title: '', body: '', type: current.type }))}>
          {scope === 'project' ? 'This project' : 'Global'}
        </button>)}
      </nav>
      {loading ? <p className="text-xs text-neutral-500">Loading memory…</p>
        : <MemoryList overview={overview} query={needle} scope={draft.scope} busy={busy}
          selectedId={selected?.id ?? null} select={select} remove={remove} />}
      <EditMemory draft={draft} setDraft={setDraft} busy={busy} available={!!selected || false} save={save} />
    </>}
  </section>;
}

function MemoryList({ overview, query, scope, busy, selectedId, select, remove }: {
  overview: AgentMemoryOverview | null; query: string; scope: AgentMemoryScope; busy: boolean;
  selectedId: string | null; select: (scope: AgentMemoryScope, entry: AgentMemoryEntry) => void;
  remove: (memoryId: string, scope: AgentMemoryScope) => Promise<void>;
}): ReactNode {
  const raw = overview?.[scope] ?? [];
  const usable = raw.filter(usableMemoryEntry);
  const needle = query.trim().toLocaleLowerCase();
  const visible = usable.filter((entry) => !query || `${entry.title} ${entry.body}`.toLocaleLowerCase().includes(needle));
  return <>
    {raw.some((entry) => !usableMemoryEntry(entry)) ? <p role="status" className="text-xs text-amber-300">
      Some memory entries could not be displayed.</p> : null}
    {overview?.[`${scope}Failed` as keyof AgentMemoryOverview] ? <p role="status" className="text-xs text-amber-300">
      This scope is unavailable; its entries are shown empty.</p> : null}
    {needle && !visible.length ? <p className="text-xs text-neutral-500">No matching memory.</p> : null}
    <ol className="min-h-0 flex-1 overflow-y-auto">{visible.map((entry) => <li key={entry.id}
      className="mb-2 rounded border border-white/10 p-2 text-xs">
      <p className="font-medium">{entry.title} <span className="text-[10px] text-neutral-400">{entry.type}</span></p>
      <p className="whitespace-pre-wrap break-words">{entry.body}</p>
      {entry.flagged ? <p className="mt-1 text-amber-300">Held back as possible model instruction.</p> : null}
      <div className="mt-1 flex gap-2">
        <button type="button" disabled={busy} className="text-sky-300" onClick={() => select(scope, entry)}>Edit</button>
        <button type="button" disabled={busy} className="text-amber-300" onClick={() => { void remove(entry.id, scope); }}>Delete</button>
        {selectedId === entry.id ? <span aria-current="true" className="text-neutral-400">editing</span> : null}
      </div>
    </li>)}</ol>
  </>;
}

function EditMemory({ draft, setDraft, busy, available, save }: {
  draft: ContextMemoryDraft; setDraft: Dispatch<SetStateAction<ContextMemoryDraft>>; busy: boolean;
  available: boolean; save: () => Promise<void>;
}): ReactNode {
  return <div className={`min-h-40 flex-shrink-0 rounded border border-white/10 p-2 ${available ? '' : 'opacity-50'}`}>
    <input aria-label="Edit memory title" value={draft.title} disabled={busy || !available} maxLength={200}
      onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
      className="w-full rounded border border-white/10 bg-neutral-900/40 p-1 text-xs" />
    <textarea aria-label="Edit memory body" value={draft.body} disabled={busy || !available} maxLength={2000}
      onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
      className="mt-1 min-h-24 w-full resize-y rounded border border-white/10 bg-neutral-900/40 p-1 text-xs" />
    <label className="mt-1 block text-[10px] text-neutral-400">Memory type
      <select aria-label="Edit memory type" value={draft.type} disabled={busy || !available}
        onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as AgentMemoryType }))}
        className="ml-1 rounded border border-white/10 bg-neutral-900/40 px-1">
        <option value="fact">fact</option><option value="preference">preference</option><option value="reference">reference</option>
      </select>
    </label>
    <button type="button" disabled={busy || !available || !draft.title.trim() || !draft.body.trim()}
      className="mt-1 text-xs" onClick={() => { void save(); }}>Save memory</button>
  </div>;
}

