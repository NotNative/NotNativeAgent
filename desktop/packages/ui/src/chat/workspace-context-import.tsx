// SPDX-License-Identifier: Apache-2.0
/** Opt-in copy from legacy repo-local files; originals are never changed. */
import { useState, type ReactNode } from 'react';
import { FileReadError, readFileText } from '../lib/files/api.ts';
import { importWorkspaceContext, ProjectContextRequestError } from '../lib/project-context-api.ts';

const NOTE_PATH = '.opencode/nnd/general-notes.md';
const TODO_PATH = '.opencode/nnd/todos.json';
interface LegacyTodo { id: string; text: string; done: boolean }
interface Preview { noteText?: string; todos?: LegacyTodo[] }

async function optionalFile(directory: string, path: string): Promise<string | undefined> {
  try { return await readFileText(directory, path, true); }
  catch (error) {
    if (error instanceof FileReadError && error.status === 404 && error.reason === 'not-found') return undefined;
    throw error;
  }
}

function parseTodos(text: string | undefined): LegacyTodo[] | undefined {
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid workspace todo file');
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid workspace todo file');
    const todo = item as Partial<LegacyTodo>;
    if (typeof todo.id !== 'string' || !todo.id || todo.id.length > 200 || ids.has(todo.id)
      || typeof todo.text !== 'string' || !todo.text.trim() || todo.text.length > 120 || typeof todo.done !== 'boolean') {
      throw new Error('Invalid workspace todo file');
    }
    ids.add(todo.id);
  }
  return value as LegacyTodo[];
}

export function WorkspaceContextImport({ directory, projectId, onImported, onClose }: {
  directory: string; projectId: string; onImported: () => void; onClose: () => void;
}): ReactNode {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function scan(): Promise<void> {
    if (busy) return;
    setBusy(true); setMessage(''); setPreview(null);
    try {
      const [noteText, todoText] = await Promise.all([optionalFile(directory, NOTE_PATH), optionalFile(directory, TODO_PATH)]);
      const todos = parseTodos(todoText);
      setPreview({ noteText, todos });
      if (!noteText?.trim() && !todos?.length) setMessage('No workspace note or todos found to copy.');
      else if (noteText && noteText.length > 3000) setMessage('Workspace note exceeds the 3,000-character note limit. Nothing has been copied.');
    } catch { setMessage('Workspace files could not be read or validated. Nothing has been copied.'); }
    finally { setBusy(false); }
  }
  async function copy(): Promise<void> {
    if (!preview || busy || (preview.noteText?.length ?? 0) > 3000) return;
    if (!preview.noteText?.trim() && !preview.todos?.length) return;
    if (!window.confirm('Copy the previewed workspace note and todos into this project? The original files will remain unchanged.')) return;
    setBusy(true); setMessage('');
    try {
      const result = await importWorkspaceContext(projectId, { directory,
        ...(preview.noteText?.trim() ? { noteText: preview.noteText } : {}),
        ...(preview.todos?.length ? { todos: preview.todos } : {}) });
      setMessage(`Copied ${result.importedNotes} note and ${result.importedTodos} todos. Original files remain unchanged.`);
      onImported();
    } catch (error) {
      setMessage(error instanceof ProjectContextRequestError && error.status === 409
        ? 'The workspace content differs from an earlier copy. Nothing was overwritten; review the existing project entries before retrying.'
        : 'Could not confirm the copy. Original files remain unchanged; retrying the same copy is safe.');
    }
    finally { setBusy(false); }
  }
  return <section className="max-h-72 overflow-y-auto border-b border-white/10 p-2 text-xs" aria-label="Copy workspace files to project context">
    <div className="flex items-center gap-2"><strong>Copy workspace files</strong>
      <button type="button" className="ml-auto underline" onClick={onClose}>Close</button></div>
    <p className="my-1 text-neutral-400">Review before copying. This does not delete or modify .opencode/nnd files.</p>
    <button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={() => { void scan(); }}>Scan workspace files</button>
    {preview ? <div className="mt-2 space-y-1">
      <p>General note: {preview.noteText === undefined ? 'not found' : `${preview.noteText.length} characters`}</p>
      {preview.noteText ? <textarea readOnly aria-label="Workspace note preview" value={preview.noteText}
        className="h-20 w-full resize-y rounded border border-white/10 bg-neutral-900/40 p-1" /> : null}
      <p>Todos: {preview.todos === undefined ? 'not found' : preview.todos.length}</p>
      {preview.todos?.length ? <ol className="max-h-20 overflow-y-auto">{preview.todos.map((todo) =>
        <li key={todo.id}>{todo.done ? '✓' : '○'} {todo.text}</li>)}</ol> : null}
      <button type="button" disabled={busy || (preview.noteText?.length ?? 0) > 3000 || (!preview.noteText?.trim() && !preview.todos?.length)}
        className="rounded border border-white/10 px-2 py-1 disabled:opacity-50" onClick={() => { void copy(); }}>Copy to project context</button>
    </div> : null}
    {message ? <p role="status" className="mt-1 text-amber-300">{message}</p> : null}
  </section>;
}
