// SPDX-License-Identifier: Apache-2.0
/** Project-owned operator notes and todos; never an implicit NNA prompt input. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readFileText, writeFileText } from '../lib/files/api.ts';
import { PlanView } from '../components/plan/PlanView.tsx';

type Tab = 'notes' | 'todos' | 'plans';
interface Todo { id: string; text: string; done: boolean }
const NOTES_PATH = '.opencode/nnd/general-notes.md';
const TODOS_PATH = '.opencode/nnd/todos.json';

export function ProjectNotes({ directory }: { directory: string }): ReactNode {
  const [tab, setTab] = useState<Tab>('notes');
  return <section className="flex h-full min-h-0 flex-col" data-testid="project-notes"><nav className="flex gap-1 border-b border-white/10 p-2">{(['notes', 'todos', 'plans'] as const).map((item) => <button key={item} type="button" className={`rounded px-2 py-1 text-[10px] ${tab === item ? 'bg-white/10 text-white' : 'text-neutral-500'}`} onClick={() => setTab(item)}>{item === 'notes' ? 'General' : item[0]!.toUpperCase() + item.slice(1)}</button>)}</nav>{tab === 'notes' ? <GeneralNotes key={directory} directory={directory} /> : null}{tab === 'todos' ? <ProjectTodos key={directory} directory={directory} /> : null}{tab === 'plans' ? <PlanView directory={directory} visible /> : null}</section>;
}

function GeneralNotes({ directory }: { directory: string }): ReactNode {
  const [text, setText] = useState(''); const [saved, setSaved] = useState('Loading…'); const [loading, setLoading] = useState(true);
  const revision = useRef(0); const live = useRef(true); const writes = useRef(Promise.resolve());
  useEffect(() => { live.current = true; void readFileText(directory, NOTES_PATH).then((value) => { if (live.current) { setText(value); setSaved('Saved'); setLoading(false); } }).catch(() => { if (live.current) { setSaved('New note'); setLoading(false); } }); return () => { live.current = false; }; }, [directory]);
  const save = (): void => { const saveRevision = revision.current; const content = text; setSaved('Saving…'); const task = writes.current.then(() => writeFileText(directory, NOTES_PATH, content)); writes.current = task.catch(() => undefined); void task.then(() => { if (live.current && revision.current === saveRevision) setSaved('Saved'); }, () => { if (live.current && revision.current === saveRevision) setSaved('Save failed'); }); };
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-3"><header className="flex text-[10px] text-neutral-500"><span>General notes</span><span className="ml-auto">{saved}</span></header><textarea className="min-h-0 flex-1 resize-none rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" value={text} disabled={loading} onChange={(e) => { revision.current += 1; setText(e.target.value); setSaved('Unsaved'); }} /><button type="button" disabled={loading} className="self-end rounded border border-white/10 px-2 py-1 text-[10px] disabled:opacity-50" onClick={save}>Save notes</button></div>;
}

function ProjectTodos({ directory }: { directory: string }): ReactNode {
  const [items, setItems] = useState<Todo[]>([]); const [draft, setDraft] = useState(''); const [loading, setLoading] = useState(true); const [saveStatus, setSaveStatus] = useState('');
  const live = useRef(true); const writes = useRef(Promise.resolve()); const writeRevision = useRef(0);
  useEffect(() => { live.current = true; void readFileText(directory, TODOS_PATH).then((text) => { const parsed: unknown = JSON.parse(text); if (live.current && Array.isArray(parsed)) setItems(parsed.filter(validTodo)); }).catch(() => undefined).finally(() => { if (live.current) setLoading(false); }); return () => { live.current = false; }; }, [directory]);
  const persist = (next: Todo[]): void => { setItems(next); setSaveStatus('Saving…'); const revision = writeRevision.current + 1; writeRevision.current = revision; const task = writes.current.then(() => writeFileText(directory, TODOS_PATH, JSON.stringify(next))); writes.current = task.catch(() => undefined); void task.then(() => { if (live.current && writeRevision.current === revision) setSaveStatus('Saved'); }, () => { if (live.current && writeRevision.current === revision) setSaveStatus('Save failed'); }); };
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-3"><header className="flex text-[10px] text-neutral-500"><span>Project todos — separate from NNA session tasks.</span><span className="ml-auto">{loading ? 'Loading…' : saveStatus}</span></header><div className="flex gap-1"><input disabled={loading} className="min-w-0 flex-1 rounded border border-white/10 bg-neutral-900/40 px-2 text-xs disabled:opacity-50" value={draft} onChange={(e) => setDraft(e.target.value)} /><button type="button" disabled={loading} className="rounded border border-white/10 px-2 text-xs disabled:opacity-50" onClick={() => { const text = draft.trim(); if (!text) return; persist([...items, { id: crypto.randomUUID(), text, done: false }]); setDraft(''); }}>Add</button></div><ol className="overflow-y-auto">{items.map((item) => <li key={item.id} className="flex gap-2 py-1 text-xs"><input type="checkbox" disabled={loading} checked={item.done} onChange={() => persist(items.map((x) => x.id === item.id ? { ...x, done: !x.done } : x))} /><span className={item.done ? 'line-through text-neutral-500' : ''}>{item.text}</span></li>)}</ol></div>;
}
function validTodo(value: unknown): value is Todo { return !!value && typeof value === 'object' && typeof (value as Todo).id === 'string' && typeof (value as Todo).text === 'string' && typeof (value as Todo).done === 'boolean'; }
