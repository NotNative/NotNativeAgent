// SPDX-License-Identifier: Apache-2.0
/** Project-owned notes; legacy repo notes stay accessible separately. */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { type ProjectContextPinTargets } from './project-context-pins.ts';
import { createProjectNote, deleteProjectNote, getProjectContext, updateProjectNote,
  type ProjectContext, type ProjectNote } from '../lib/project-context-api.ts';

function usableNote(value: unknown): value is ProjectNote {
  return !!value && typeof value === 'object' && typeof (value as ProjectNote).id === 'string'
    && typeof (value as ProjectNote).body === 'string';
}

export interface ContextNotesDraft { draft: string; editing: string | null; editBody: string }

function useContextLoad(projectId: string, visible: boolean, refreshToken: number): {
  context: ProjectContext | null; setContext: Dispatch<SetStateAction<ProjectContext | null>>;
  loading: boolean; error: string; setError: Dispatch<SetStateAction<string>>;
  refresh: () => void; requestSequence: MutableRefObject<number>;
} {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  useEffect(() => loadContextOnce({ projectId, visible, revision, refreshToken,
    sequence: requestSequence, setContext, setError, setLoading }),
  [projectId, revision, visible, refreshToken, setError, setLoading, setContext]);
  return { context, setContext, loading, error, setError,
    refresh: () => setRevision((value) => value + 1), requestSequence };
}

function loadContextOnce(input: { projectId: string; visible: boolean; revision: number; refreshToken: number;
  sequence: MutableRefObject<number>; setContext: Dispatch<SetStateAction<ProjectContext | null>>;
  setError: Dispatch<SetStateAction<string>>; setLoading: Dispatch<SetStateAction<boolean>>;
}): () => void {
  if (!input.visible) return () => undefined;
  let active = true;
  const sequence = ++input.sequence.current;
  input.setLoading(true);
  void getProjectContext(input.projectId).then((value) => {
    if (active && sequence === input.sequence.current) { input.setContext(value); input.setError(''); input.setLoading(false); }
  }).catch(() => { if (active && sequence === input.sequence.current) {
    input.setError('Context could not be loaded. Existing notes were left untouched.'); input.setLoading(false);
  } });
  return () => { active = false; };
}

export function ContextNotes({ projectId, visible, query = '', refreshToken = 0, retainedDraft, onDraftChange,
  draftPins, onToggleNotePin, pinBusy = false, pinLabel = 'Pin to draft', pinError, pinTargetLabel = 'the new-session draft' }: {
  projectId: string; visible: boolean; query?: string; refreshToken?: number; retainedDraft?: ContextNotesDraft;
  onDraftChange?: (projectId: string, draft: ContextNotesDraft) => void;
  draftPins?: ProjectContextPinTargets;
  onToggleNotePin?: (noteID: string, pinned: boolean) => void;
  pinBusy?: boolean;
  pinLabel?: string;
  pinError?: string | null;
  pinTargetLabel?: string;
}): ReactNode {
  const { context, setContext, loading, error, setError, refresh, requestSequence } = useContextLoad(projectId, visible, refreshToken);
  const [draftState, setDraftState] = useState<ContextNotesDraft>(() => retainedDraft ?? { draft: '', editing: null, editBody: '' });
  const { draft, editing, editBody } = draftState;
  const setDraft = (value: string): void => setDraftState((current) => ({ ...current, draft: value }));
  const setEditing = (value: string | null): void => setDraftState((current) => ({ ...current, editing: value }));
  const setEditBody = (value: string): void => setDraftState((current) => ({ ...current, editBody: value }));
  const [busy, setBusy] = useState(false);
  useEffect(() => { onDraftChange?.(projectId, draftState); }, [draftState, onDraftChange, projectId]);
  const actions = useProjectNoteActions({ projectId, draft, editing, editBody, busy, setBusy,
    setContext, setError, setEditing, setDraft, requestSequence });
  const saveNew = actions.saveNew;
  const saveEdit = actions.saveEdit;
  const remove = actions.remove;

  return <section className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="project-context-notes">
    <ContextNotesHeader busy={busy} refresh={refresh} />
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
  {pinError ? <p role="alert" className="text-xs text-amber-300">{pinError}</p> : null}
    {!context ? loading ? <p className="text-xs text-neutral-500">Loading project context…</p> : null : <>
      <textarea aria-label="New context note" value={draft} onChange={(event) => setDraft(event.target.value)}
        maxLength={3000} disabled={busy} className="min-h-16 resize-y rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" />
      <button type="button" disabled={busy || !draft.trim()} onClick={() => { void saveNew(); }}
        className="self-end rounded border border-white/10 px-2 py-1 text-[10px] disabled:opacity-50">Add note</button>
      <ContextNoteList notes={context.notes} query={query} editing={editing} editBody={editBody} busy={busy}
        setEditing={setEditing} setEditBody={setEditBody} saveEdit={saveEdit} remove={remove}
    pinnedIDs={new Set(draftPins?.notes ?? [])} onTogglePin={onToggleNotePin} pinBusy={pinBusy} pinLabel={pinLabel} pinTargetLabel={pinTargetLabel} />
    </>}
  </section>;
}

function ContextNotesHeader({ busy, refresh }: { busy: boolean; refresh: () => void }): ReactNode {
  return <header className="flex items-center gap-2 text-[10px] text-neutral-400">
    <span>Project-owned notes — separate from the workspace note file</span>
    <button type="button" className="ml-auto underline" disabled={busy} onClick={refresh}>Refresh</button>
  </header>;
}

function useProjectNoteActions(input: { projectId: string; draft: string; editing: string | null;
  editBody: string; busy: boolean; setBusy: Dispatch<SetStateAction<boolean>>;
  setContext: Dispatch<SetStateAction<ProjectContext | null>>; setError: Dispatch<SetStateAction<string>>;
  setEditing: (value: string | null) => void; setDraft: (value: string) => void;
  requestSequence: MutableRefObject<number>;
}): { saveNew: () => Promise<void>; saveEdit: () => Promise<void>; remove: (id: string) => Promise<void> } {
  async function saveNew(): Promise<void> {
    const body = input.draft.trim();
    if (!body || input.busy) return;
    ++input.requestSequence.current; input.setBusy(true); input.setError('');
    try {
      const committed = await createProjectNote(input.projectId, { body });
      ++input.requestSequence.current; input.setContext(committed.context); input.setDraft('');
    } catch { input.setError('Note could not be saved. The draft is still here.'); }
    finally { input.setBusy(false); }
  }
  async function saveEdit(): Promise<void> {
    if (!input.editing || !input.editBody.trim() || input.busy) return;
    ++input.requestSequence.current; input.setBusy(true); input.setError('');
    try {
      const note = await updateProjectNote(input.projectId, input.editing, { body: input.editBody });
      ++input.requestSequence.current;
      input.setContext((current) => current ? { ...current,
        notes: current.notes.map((item) => item.id === note.id ? note : item) } : current);
      input.setEditing(null);
    } catch { input.setError('Note edit failed. Your draft is still here.'); }
    finally { input.setBusy(false); }
  }
  async function remove(noteId: string): Promise<void> {
    if (input.busy) return;
    ++input.requestSequence.current; input.setBusy(true); input.setError('');
    try { const committed = await deleteProjectNote(input.projectId, noteId);
      ++input.requestSequence.current; input.setContext(committed); }
    catch { input.setError('Note could not be deleted.'); }
    finally { input.setBusy(false); }
  }
  return { saveNew, saveEdit, remove };
}

function ContextNoteList({ notes, query, editing, editBody, busy, setEditing, setEditBody, saveEdit, remove,
  pinnedIDs, onTogglePin, pinBusy, pinLabel, pinTargetLabel }: {
  notes: ProjectNote[]; query: string; editing: string | null; editBody: string; busy: boolean;
  setEditing: (value: string | null) => void; setEditBody: (value: string) => void;
  saveEdit: () => Promise<void>; remove: (id: string) => Promise<void>;
  pinnedIDs: Set<string>;
  onTogglePin?: (noteID: string, pinned: boolean) => void;
  pinBusy?: boolean;
  pinLabel?: string;
  pinTargetLabel?: string;
}): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  const visibleNotes = notes.filter(usableNote).filter((note) => !needle || note.body.toLocaleLowerCase().includes(needle));
  return <>
    {notes.some((note) => !usableNote(note)) ? <p role="status" className="text-xs text-amber-300">Some stored notes could not be displayed. Refresh or inspect project context before editing.</p> : null}
    {needle && !visibleNotes.length ? <p className="text-xs text-neutral-500">No matching notes.</p> : null}
    <ol className="min-h-0 overflow-y-auto">{visibleNotes.map((note) => <li key={note.id}
      className="mb-2 rounded border border-white/10 p-2 text-xs">
      {editing === note.id ? <>
        <textarea aria-label="Edit context note" value={editBody} onChange={(event) => setEditBody(event.target.value)}
          maxLength={3000} disabled={busy} className="min-h-20 w-full resize-y bg-neutral-900/40 p-1" />
        <button type="button" disabled={busy || !editBody.trim()} onClick={() => { void saveEdit(); }}>Save edit</button>
        <button type="button" disabled={busy} className="ml-2" onClick={() => setEditing(null)}>Cancel</button>
      </> : <>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        <button type="button" disabled={busy || pinBusy || !onTogglePin} className="mt-2 text-amber-300"
          aria-label={`Pin ${note.id} to ${pinTargetLabel}`}
          aria-pressed={pinnedIDs.has(note.id)} onClick={() => onTogglePin?.(note.id, !pinnedIDs.has(note.id))}>
          {pinnedIDs.has(note.id) ? 'Pinned' : pinLabel}
        </button>
        <button type="button" disabled={busy} className="mt-2 ml-2 text-sky-300" onClick={() => {
          setEditing(note.id); setEditBody(note.body);
        }}>Edit</button>
        <button type="button" disabled={busy} className="ml-2 text-amber-300" onClick={() => { void remove(note.id); }}>Delete</button>
      </>}
    </li>)}</ol>
  </>;
}
