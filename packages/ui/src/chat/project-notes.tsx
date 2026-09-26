// SPDX-License-Identifier: Apache-2.0
/** Project-owned operator notes and todos; never an implicit NNA prompt input. */
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { FileReadError, readFileText, writeFileText } from '../lib/files/api.ts';
import { PlanView } from '../components/plan/PlanView.tsx';
import { ContextNotes, type ContextNotesDraft } from './context-notes.tsx';
import { ContextPlans, type ContextPlanDraft } from './context-plans.tsx';
import { ContextTodos, usableTodo } from './context-todos.tsx';
import { getProjectContext, type ProjectContext } from '../lib/project-context-api.ts';

type Tab = 'notes' | 'todos' | 'plans' | 'context' | 'saved' | 'project-todos';
interface Todo { id: string; text: string; done: boolean }
const NOTES_PATH = '.opencode/nnd/general-notes.md';
const TODOS_PATH = '.opencode/nnd/todos.json';

function searchCounts(context: ProjectContext, query: string): { context: number; 'project-todos': number; saved: number } {
  const needle = query.trim().toLocaleLowerCase();
  const contains = (value: unknown): boolean => typeof value === 'string' && value.toLocaleLowerCase().includes(needle);
  const todosUsable = context.todos.length <= 500 && context.todos.every(usableTodo)
    && new Set(context.todos.map((todo) => (todo as { id: string }).id)).size === context.todos.length;
  return {
    context: context.notes.filter((note) => note && typeof note.id === 'string' && contains(note.body)).length,
    'project-todos': todosUsable ? context.todos.filter((todo) => contains((todo as { text: string }).text)).length : 0,
    saved: context.plans.filter((plan) => !!plan && typeof plan === 'object'
      && typeof (plan as { id?: unknown }).id === 'string' && contains((plan as { title?: unknown }).title)).length,
  };
}

export interface NotesDraftLease { directoryKey: string; text: string; revision: number }
type SetDraftLease = Dispatch<SetStateAction<NotesDraftLease | null>>;

export function ProjectNotes({ directory, directoryKey, projectId, visible, draftLease, setDraftLease, contextDraft, onContextDraftChange, planDraft, onPlanDraftChange, todoDraft, onTodoDraftChange }: {
  directory: string; directoryKey: string; projectId: string | null; visible: boolean;
  draftLease: NotesDraftLease | null; setDraftLease: SetDraftLease;
  contextDraft?: ContextNotesDraft; onContextDraftChange?: (projectId: string, draft: ContextNotesDraft) => void;
  planDraft?: ContextPlanDraft; onPlanDraftChange?: (projectId: string, draft: ContextPlanDraft) => void;
  todoDraft?: string; onTodoDraftChange?: (projectId: string, draft: string) => void;
}): ReactNode {
  const [tab, setTab] = useState<Tab>(() => projectId ? 'context' : 'notes');
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([projectId ? 'context' : 'notes']));
  const [workspaceFilesOpen, setWorkspaceFilesOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchSnapshot, setSearchSnapshot] = useState<{ projectId: string; context: ProjectContext } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const searchEnabled = !!query.trim();
  useEffect(() => {
    if (!projectId || !visible || !searchEnabled) return;
    let active = true;
    setSearchLoading(true); setSearchError(false); setSearchSnapshot(null);
    void getProjectContext(projectId).then((context) => {
      if (active) { setSearchSnapshot({ projectId, context }); setSearchLoading(false); }
    }).catch(() => {
      if (active) { setSearchError(true); setSearchLoading(false); }
    });
    return () => { active = false; };
  }, [projectId, visible, searchEnabled, searchRevision]);
  const counts = searchEnabled && searchSnapshot?.projectId === projectId ? searchCounts(searchSnapshot.context, query) : null;
  const activeTab = !projectId && (tab === 'context' || tab === 'saved' || tab === 'project-todos') ? 'notes'
    : projectId && !workspaceFilesOpen && (tab === 'notes' || tab === 'todos' || tab === 'plans') ? 'context' : tab;
  const primaryTabs: { id: Tab; label: string }[] = projectId
    ? [{ id: 'context', label: 'General' }, { id: 'project-todos', label: 'Todos' }, { id: 'saved', label: 'Plans' }]
    : [{ id: 'notes', label: 'General' }, { id: 'todos', label: 'Todos' }, { id: 'plans', label: 'Plans' }];
  const selectTab = (item: Tab): void => {
    setOpened((current) => new Set([...current, item]));
    setTab(item);
  };
  return <section className="flex h-full min-h-0 flex-col" data-testid="project-notes">
    <nav className="flex flex-wrap gap-1 border-b border-white/10 p-2" aria-label="Project notes sections">
      {primaryTabs.map((item) => <button key={item.id} type="button" aria-current={activeTab === item.id ? 'page' : undefined}
        className={`rounded px-2 py-1 text-[10px] ${activeTab === item.id ? 'bg-white/10 text-white' : 'text-neutral-500'}`}
        onClick={() => selectTab(item.id)}>{item.label}</button>)}
      {projectId ? <button type="button" aria-expanded={workspaceFilesOpen} aria-controls="workspace-note-files"
        className="ml-auto rounded px-2 py-1 text-[10px] text-neutral-500 hover:text-neutral-200"
        onClick={() => { setWorkspaceFilesOpen((current) => !current); if (tab === 'notes' || tab === 'todos' || tab === 'plans') setTab('context'); }}>
        Workspace files {workspaceFilesOpen ? '▴' : '▾'}
      </button> : null}
    </nav>
    {projectId && (activeTab === 'context' || activeTab === 'project-todos' || activeTab === 'saved') ? <div className="border-b border-white/10 px-2 py-1">
      <input aria-label="Search project notes, todos, and plan titles" type="search" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="Search notes, todos, plan titles"
        className="w-full rounded border border-white/10 bg-neutral-900/40 px-2 py-1 text-xs" />
      {searchEnabled ? <div className="mt-1 text-[10px] text-neutral-500">
        {searchLoading ? <span role="status">Counting matches…</span> : searchError ? <span role="alert">Match counts unavailable. Section lists may still be searched.</span> : counts ? <nav aria-label="Search matches by section" className="flex flex-wrap gap-2">
          {([{ id: 'context', label: 'General' }, { id: 'project-todos', label: 'Todos' }, { id: 'saved', label: 'Plans' }] as const).map((item) =>
            <button key={item.id} type="button" onClick={() => selectTab(item.id)} className="underline"
              aria-label={`${item.label}: ${counts[item.id]} snapshot matches`}>{item.label} {counts[item.id]}</button>)}
        </nav> : null}
        <button type="button" className="mt-1 underline" onClick={() => setSearchRevision((current) => current + 1)}>Refresh match counts</button>
        <span className="ml-2">Snapshot counts; refresh after changes.</span>
      </div> : null}
    </div> : null}
    {projectId && workspaceFilesOpen ? <div id="workspace-note-files" className="border-b border-white/10 px-2 pb-2">
      <p className="pb-1 text-[10px] text-neutral-500">Existing repo-local files remain separate; nothing has been moved.</p>
      <nav className="flex flex-wrap gap-1" aria-label="Legacy workspace notes">
        {([{ id: 'notes', label: 'Note file' }, { id: 'todos', label: 'Todo file' }, { id: 'plans', label: 'Session plan' }] as const).map((item) =>
          <button key={item.id} type="button" aria-current={activeTab === item.id ? 'page' : undefined}
            className={`rounded px-2 py-1 text-[10px] ${activeTab === item.id ? 'bg-white/10 text-white' : 'text-neutral-500'}`}
            onClick={() => selectTab(item.id)}>{item.label}</button>)}
      </nav>
    </div> : null}
    {opened.has('notes') || activeTab === 'notes' ? <div className={activeTab === 'notes' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><GeneralNotes key={directoryKey} directory={directory} directoryKey={directoryKey} draftLease={draftLease} setDraftLease={setDraftLease} /></div> : null}
    {opened.has('todos') ? <div className={activeTab === 'todos' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><ProjectTodos key={directory} directory={directory} /></div> : null}
    {opened.has('plans') ? <div className={activeTab === 'plans' ? 'min-h-0 flex-1' : 'hidden'}><PlanView directory={directory} visible={visible && activeTab === 'plans'} /></div> : null}
    {projectId && (opened.has('context') || activeTab === 'context') ? <div className={activeTab === 'context' ? 'min-h-0 flex-1' : 'hidden'}><ContextNotes key={projectId} projectId={projectId} visible={visible && activeTab === 'context'} query={query} retainedDraft={contextDraft} onDraftChange={onContextDraftChange} /></div> : null}
    {projectId && (opened.has('saved') || activeTab === 'saved') ? <div className={activeTab === 'saved' ? 'min-h-0 flex-1' : 'hidden'}><ContextPlans key={projectId} projectId={projectId} visible={visible && activeTab === 'saved'} query={query} retainedDraft={planDraft} onDraftChange={onPlanDraftChange} /></div> : null}
    {projectId && (opened.has('project-todos') || activeTab === 'project-todos') ? <div className={activeTab === 'project-todos' ? 'min-h-0 flex-1' : 'hidden'}><ContextTodos key={projectId} projectId={projectId} visible={visible && activeTab === 'project-todos'} query={query} retainedDraft={todoDraft} onDraftChange={onTodoDraftChange} /></div> : null}
  </section>;
}

function GeneralNotes({ directory, directoryKey, draftLease, setDraftLease }: {
  directory: string; directoryKey: string; draftLease: NotesDraftLease | null; setDraftLease: SetDraftLease;
}): ReactNode {
  const [text, setText] = useState(''); const [saved, setSaved] = useState('Loading…'); const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const revision = useRef(0); const live = useRef(true); const writes = useRef(Promise.resolve());
  const latestLease = useRef(draftLease);
  latestLease.current = draftLease;
  const ownLease = draftLease?.directoryKey === directoryKey ? draftLease : null;
  const locked = draftLease !== null && ownLease === null;
  useEffect(() => {
    let active = true;
    live.current = true;
    void readFileText(directory, NOTES_PATH).then((value) => {
      if (!active) return;
      const lease = latestLease.current;
      setText(lease?.directoryKey === directoryKey ? lease.text : value);
      setSaved(lease?.directoryKey === directoryKey ? 'Unsaved' : 'Saved');
      setLoadFailed(false); setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      const missing = error instanceof FileReadError && error.status === 404 && error.reason === 'not-found';
      const lease = latestLease.current;
      if (missing && lease?.directoryKey === directoryKey) setText(lease.text);
      setSaved(missing ? lease?.directoryKey === directoryKey ? 'Unsaved' : 'New note' : 'Load failed — existing note left untouched');
      setLoadFailed(!missing); setLoading(false);
    });
    return () => { active = false; live.current = false; };
  }, [directory, directoryKey, loadAttempt]);
  const save = (): void => {
    if (loading || loadFailed || locked) return;
    const saveRevision = revision.current;
    const content = text;
    const leaseRevision = latestLease.current?.directoryKey === directoryKey ? latestLease.current.revision : null;
    setSaved('Saving…');
    const task = writes.current.then(() => writeFileText(directory, NOTES_PATH, content));
    writes.current = task.catch(() => undefined);
    void task.then(() => {
      if (leaseRevision !== null) setDraftLease((current) => current?.directoryKey === directoryKey && current.revision === leaseRevision ? null : current);
      if (live.current && revision.current === saveRevision) setSaved('Saved');
    }, () => { if (live.current && revision.current === saveRevision) setSaved('Save failed'); });
  };
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
    <header className="flex text-[10px] text-neutral-500"><span>General notes</span><span className="ml-auto">{saved}</span></header>
    {loadFailed ? <button type="button" className="self-start text-xs text-amber-300 underline" onClick={() => {
      setLoading(true); setSaved('Loading…'); setLoadAttempt((current) => current + 1);
    }}>Retry load</button> : null}
    {locked ? <OtherDraftWarning directoryKey={directoryKey} setDraftLease={setDraftLease} /> : null}
    <textarea className="min-h-0 flex-1 resize-none rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" value={ownLease?.text ?? text} disabled={loading || loadFailed || locked} onChange={(e) => {
      const next = e.target.value;
      revision.current += 1; setText(next); setSaved('Unsaved');
      setDraftLease((current) => current && current.directoryKey !== directoryKey ? current : { directoryKey, text: next, revision: (current?.revision ?? 0) + 1 });
    }} />
    <button type="button" disabled={loading || loadFailed || locked} className="self-end rounded border border-white/10 px-2 py-1 text-[10px] disabled:opacity-50" onClick={save}>Save notes</button>
  </div>;
}

function OtherDraftWarning({ directoryKey, setDraftLease }: { directoryKey: string; setDraftLease: SetDraftLease }): ReactNode {
  return <div role="status" className="text-xs text-amber-300">Unsaved notes in another project. Return there to save, or discard that draft before editing here.
    <button type="button" className="ml-2 underline" onClick={() => {
      if (window.confirm('Discard the unsaved General Notes draft in the other project?')) setDraftLease((current) => current?.directoryKey === directoryKey ? current : null);
    }}>Discard other draft</button>
  </div>;
}

function ProjectTodos({ directory }: { directory: string }): ReactNode {
  const [items, setItems] = useState<Todo[]>([]); const [draft, setDraft] = useState(''); const [loading, setLoading] = useState(true); const [saveStatus, setSaveStatus] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const live = useRef(true); const writes = useRef(Promise.resolve()); const writeRevision = useRef(0);
  useEffect(() => { live.current = true; void readFileText(directory, TODOS_PATH).then((text) => { const parsed: unknown = JSON.parse(text); if (!Array.isArray(parsed) || !parsed.every(validTodo)) throw new Error('Invalid project todos'); if (live.current) setItems(parsed); }).catch((error: unknown) => { if (live.current && !(error instanceof FileReadError && error.status === 404 && error.reason === 'not-found')) { setLoadFailed(true); setSaveStatus('Load failed — existing todos left untouched'); } }).finally(() => { if (live.current) setLoading(false); }); return () => { live.current = false; }; }, [directory]);
  const persist = (next: Todo[]): void => { setItems(next); setSaveStatus('Saving…'); const revision = writeRevision.current + 1; writeRevision.current = revision; const task = writes.current.then(() => writeFileText(directory, TODOS_PATH, JSON.stringify(next))); writes.current = task.catch(() => undefined); void task.then(() => { if (live.current && writeRevision.current === revision) setSaveStatus('Saved'); }, () => { if (live.current && writeRevision.current === revision) setSaveStatus('Save failed'); }); };
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-3"><header className="flex text-[10px] text-neutral-500"><span>Project todos — separate from NNA session tasks.</span><span className="ml-auto">{loading ? 'Loading…' : saveStatus}</span></header><div className="flex gap-1"><input disabled={loading || loadFailed} className="min-w-0 flex-1 rounded border border-white/10 bg-neutral-900/40 px-2 text-xs disabled:opacity-50" value={draft} onChange={(e) => setDraft(e.target.value)} /><button type="button" disabled={loading || loadFailed} className="rounded border border-white/10 px-2 text-xs disabled:opacity-50" onClick={() => { const text = draft.trim(); if (!text) return; persist([...items, { id: crypto.randomUUID(), text, done: false }]); setDraft(''); }}>Add</button></div><ol className="overflow-y-auto">{items.map((item) => <li key={item.id} className="flex gap-2 py-1 text-xs"><input type="checkbox" disabled={loading || loadFailed} checked={item.done} onChange={() => persist(items.map((x) => x.id === item.id ? { ...x, done: !x.done } : x))} /><span className={item.done ? 'line-through text-neutral-500' : ''}>{item.text}</span></li>)}</ol></div>;
}
function validTodo(value: unknown): value is Todo { return !!value && typeof value === 'object' && typeof (value as Todo).id === 'string' && typeof (value as Todo).text === 'string' && typeof (value as Todo).done === 'boolean'; }
