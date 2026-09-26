// SPDX-License-Identifier: Apache-2.0
/** Transitional NND-owned project context notes; legacy repo notes stay visible separately. */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { createProjectNote, deleteProjectNote, getProjectContext, updateProjectNote,
  type ProjectContext, type ProjectNote } from '../lib/project-context-api.ts';

function usableNote(value: unknown): value is ProjectNote {
  return !!value && typeof value === 'object' && typeof (value as ProjectNote).id === 'string'
    && typeof (value as ProjectNote).body === 'string';
}

export interface ContextNotesDraft { draft: string; editing: string | null; editBody: string }

function useContextLoad(projectId: string, visible: boolean): {
  context: ProjectContext | null; setContext: Dispatch<SetStateAction<ProjectContext | null>>;
  loading: boolean; error: string; setError: Dispatch<SetStateAction<string>>;
  refresh: () => void; requestSequence: MutableRefObject<number>;
} {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const sequence = ++requestSequence.current;
    setLoading(true);
    void getProjectContext(projectId).then((value) => {
      if (active && sequence === requestSequence.current) { setContext(value); setError(''); setLoading(false); }
    }).catch(() => { if (active && sequence === requestSequence.current) {
      setError('Context could not be loaded. Existing notes were left untouched.'); setLoading(false);
    } });
    return () => { active = false; };
  }, [projectId, revision, visible]);
  return { context, setContext, loading, error, setError,
    refresh: () => setRevision((value) => value + 1), requestSequence };
}

export function ContextNotes({ projectId, visible, retainedDraft, onDraftChange }: {
  projectId: string; visible: boolean; retainedDraft?: ContextNotesDraft;
  onDraftChange?: (projectId: string, draft: ContextNotesDraft) => void;
}): ReactNode {
  const { context, setContext, loading, error, setError, refresh, requestSequence } = useContextLoad(projectId, visible);
  const [draftState, setDraftState] = useState<ContextNotesDraft>(() => retainedDraft ?? { draft: '', editing: null, editBody: '' });
  const { draft, editing, editBody } = draftState;
  const setDraft = (value: string): void => setDraftState((current) => ({ ...current, draft: value }));
  const setEditing = (value: string | null): void => setDraftState((current) => ({ ...current, editing: value }));
  const setEditBody = (value: string): void => setDraftState((current) => ({ ...current, editBody: value }));
  const [busy, setBusy] = useState(false);
  useEffect(() => { onDraftChange?.(projectId, draftState); }, [draftState, onDraftChange, projectId]);
  async function saveNew(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    ++requestSequence.current;
    setBusy(true); setError('');
    try {
      const committed = await createProjectNote(projectId, { body });
      ++requestSequence.current;
      setContext(committed.context); setDraft('');
    } catch { setError('Note could not be saved. The draft is still here.'); }
    finally { setBusy(false); }
  }
  async function saveEdit(): Promise<void> {
    if (!editing || !editBody.trim() || busy) return;
    ++requestSequence.current;
    setBusy(true); setError('');
    try {
      const note = await updateProjectNote(projectId, editing, { body: editBody });
      ++requestSequence.current;
      setContext((current) => current ? { ...current,
        notes: current.notes.map((item) => item.id === note.id ? note : item) } : current);
      setEditing(null);
    } catch { setError('Note edit failed. Your draft is still here.'); }
    finally { setBusy(false); }
  }

  async function remove(noteId: string): Promise<void> {
    if (busy) return;
    ++requestSequence.current;
    setBusy(true); setError('');
    try { const committed = await deleteProjectNote(projectId, noteId); ++requestSequence.current; setContext(committed); }
    catch { setError('Note could not be deleted.'); }
    finally { setBusy(false); }
  }

  return <section className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="project-context-notes">
    <ContextNotesHeader busy={busy} refresh={refresh} />
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
    {!context ? loading ? <p className="text-xs text-neutral-500">Loading project context…</p> : null : <>
      <textarea aria-label="New context note" value={draft} onChange={(event) => setDraft(event.target.value)}
        maxLength={3000} disabled={busy} className="min-h-16 resize-y rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" />
      <button type="button" disabled={busy || !draft.trim()} onClick={() => { void saveNew(); }}
        className="self-end rounded border border-white/10 px-2 py-1 text-[10px] disabled:opacity-50">Add note</button>
      <ContextNoteList notes={context.notes} editing={editing} editBody={editBody} busy={busy}
        setEditing={setEditing} setEditBody={setEditBody} saveEdit={saveEdit} remove={remove} />
    </>}
  </section>;
}

function ContextNotesHeader({ busy, refresh }: { busy: boolean; refresh: () => void }): ReactNode {
  return <header className="flex items-center gap-2 text-[10px] text-neutral-400">
    <span>NND project context — separate from General notes</span>
    <button type="button" className="ml-auto underline" disabled={busy} onClick={refresh}>Refresh</button>
  </header>;
}

function ContextNoteList({ notes, editing, editBody, busy, setEditing, setEditBody, saveEdit, remove }: {
  notes: ProjectNote[]; editing: string | null; editBody: string; busy: boolean;
  setEditing: (value: string | null) => void; setEditBody: (value: string) => void;
  saveEdit: () => Promise<void>; remove: (id: string) => Promise<void>;
}): ReactNode {
  return <>
    {notes.some((note) => !usableNote(note)) ? <p role="status" className="text-xs text-amber-300">Some stored notes could not be displayed. Refresh or inspect project context before editing.</p> : null}
    <ol className="min-h-0 overflow-y-auto">{notes.filter(usableNote).map((note) => <li key={note.id}
      className="mb-2 rounded border border-white/10 p-2 text-xs">
      {editing === note.id ? <>
        <textarea aria-label="Edit context note" value={editBody} onChange={(event) => setEditBody(event.target.value)}
          maxLength={3000} disabled={busy} className="min-h-20 w-full resize-y bg-neutral-900/40 p-1" />
        <button type="button" disabled={busy || !editBody.trim()} onClick={() => { void saveEdit(); }}>Save edit</button>
        <button type="button" disabled={busy} className="ml-2" onClick={() => setEditing(null)}>Cancel</button>
      </> : <>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        <button type="button" disabled={busy} className="mt-2 text-sky-300" onClick={() => {
          setEditing(note.id); setEditBody(note.body);
        }}>Edit</button>
        <button type="button" disabled={busy} className="ml-2 text-amber-300" onClick={() => { void remove(note.id); }}>Delete</button>
      </>}
    </li>)}</ol>
  </>;
}
