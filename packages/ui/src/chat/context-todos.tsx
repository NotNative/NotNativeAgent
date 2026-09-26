// SPDX-License-Identifier: Apache-2.0
/** NND-owned project todos, separate from NNA session tasks and legacy repo todos. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getProjectContext, ProjectContextRequestError, replaceProjectTodos, type ProjectContext, type ProjectTodo } from '../lib/project-context-api.ts';

export function usableTodo(value: unknown): value is ProjectTodo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const todo = value as ProjectTodo;
  return typeof todo.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(todo.id)
    && typeof todo.text === 'string' && !!todo.text.trim() && todo.text.length <= 120
    && typeof todo.completed === 'boolean' && Number.isSafeInteger(todo.createdAt) && todo.createdAt >= 0;
}

export function ContextTodos({ projectId, visible, query = '', refreshToken = 0, retainedDraft, onDraftChange }: {
  projectId: string; visible: boolean; query?: string; refreshToken?: number; retainedDraft?: string; onDraftChange?: (projectId: string, draft: string) => void;
}): ReactNode {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [draft, setDraft] = useState(() => retainedDraft ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { onDraftChange?.(projectId, draft); }, [draft, onDraftChange, projectId]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const token = ++sequence.current;
    setLoading(true);
    void getProjectContext(projectId).then((value) => {
      if (active && token === sequence.current) { setContext(value); setError(''); setConflicted(false); setLoading(false); }
    }).catch(() => { if (active && token === sequence.current) {
      setError('Project todos could not be loaded. Existing items were left untouched.'); setLoading(false);
    } });
    return () => { active = false; };
  }, [projectId, revision, visible, refreshToken]);

  const malformed = !!context && (context.todos.length > 500 || context.todos.some((item) => !usableTodo(item))
    || new Set(context.todos.map((item) => (item as ProjectTodo).id)).size !== context.todos.length);
  const missingRevision = !!context && (typeof context.todosRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(context.todosRevision));
  const todos = context && !malformed ? context.todos as ProjectTodo[] : [];
  async function commit(next: ProjectTodo[], clearDraft = false): Promise<void> {
    if (busy || loading || !context || malformed || missingRevision || conflicted) return;
    ++sequence.current;
    setBusy(true); setError('');
    try {
      const committed = await replaceProjectTodos(projectId, next, context.todosRevision!);
      if (live.current) { ++sequence.current; setContext(committed); setError(''); if (clearDraft) setDraft(''); }
    } catch (failure) { if (live.current) {
      if (failure instanceof ProjectContextRequestError && failure.status === 409) {
        setConflicted(true);
        setError('Project todos changed in another window. Refresh before editing; your draft and last saved list remain.');
      } else setError('Todo change could not be saved. Your draft and last saved list remain.');
    } }
    // A visibility-triggered refresh can begin while this write is in flight.
    // The write fences that older read, so it must also clear its loading flag.
    finally { if (live.current) { setBusy(false); setLoading(false); } }
  }
  return <section className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="project-context-todos">
    <header className="flex items-center text-[10px] text-neutral-400">NND project todos — separate from session tasks
      <button type="button" disabled={busy} className="ml-auto underline" onClick={() => setRevision((value) => value + 1)}>Refresh</button>
    </header>
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
    {malformed ? <p role="status" className="text-xs text-amber-300">Some stored todos are malformed. Editing is disabled to avoid losing them.</p> : null}
    {missingRevision ? <p role="status" className="text-xs text-amber-300">Todo revision is unavailable. Refresh or update the server before editing.</p> : null}
    {!context && loading ? <p className="text-xs text-neutral-500">Loading project todos…</p> : null}
    {context ? <ContextTodoEditor todos={todos} query={query} draft={draft} setDraft={setDraft} busy={busy || loading || malformed || missingRevision || conflicted}
      commit={commit} /> : null}
  </section>;
}

function ContextTodoEditor({ todos, query, draft, setDraft, busy, commit }: {
  todos: ProjectTodo[]; query: string; draft: string; setDraft: (value: string) => void; busy: boolean;
  commit: (next: ProjectTodo[], clearDraft?: boolean) => Promise<void>;
}): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  const visibleTodos = todos.filter((todo) => !needle || todo.text.toLocaleLowerCase().includes(needle));
  const add = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    void commit([...todos, { id: crypto.randomUUID(), text, completed: false, createdAt: Date.now() }], true);
  };
  return <>
    <div className="flex gap-1"><input aria-label="New project todo" value={draft} maxLength={120} disabled={busy}
      onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 rounded border border-white/10 bg-neutral-900/40 px-2 text-xs" />
    <button type="button" disabled={busy || !draft.trim()} onClick={add} className="text-xs">Add todo</button></div>
    {needle && !visibleTodos.length ? <p className="text-xs text-neutral-500">No matching todos.</p> : null}
    <ol className="min-h-0 overflow-y-auto">{visibleTodos.map((todo) => <li key={todo.id} className="flex items-center gap-2 py-1 text-xs">
      <input aria-label={`Complete ${todo.text}`} type="checkbox" disabled={busy} checked={todo.completed}
        onChange={() => { void commit(todos.map((item) => item.id === todo.id ? { ...item, completed: !item.completed } : item)); }} />
      <span className={`min-w-0 flex-1 break-words ${todo.completed ? 'text-neutral-500 line-through' : ''}`}>{todo.text}</span>
      <button type="button" disabled={busy} aria-label={`Delete ${todo.text}`} onClick={() => {
        void commit(todos.filter((item) => item.id !== todo.id));
      }}>Delete</button>
    </li>)}</ol>
  </>;
}
