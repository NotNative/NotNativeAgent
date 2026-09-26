// SPDX-License-Identifier: Apache-2.0
/** Explicit, append-only copy of legacy workspace data into NND project context. */
import { createHash } from 'node:crypto';
import { ContextInputError, mutateProjectContext, type ProjectContext, type ProjectNote } from './context-store.ts';
import { validateProjectTodos, type ProjectTodo } from './todo-schema.ts';

interface LegacyTodo { id: string; text: string; done: boolean }
export interface WorkspaceImportInput { directory: string; noteText?: string; todos?: LegacyTodo[] }

function importId(kind: string, directory: string, value: string): string {
  return `import-${createHash('sha256').update(`${kind}\0${directory}\0${value}`).digest('hex').slice(0, 32)}`;
}

function checkInput(value: unknown): WorkspaceImportInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContextInputError('invalid workspace import', 400);
  const input = value as Record<string, unknown>;
  if (typeof input.directory !== 'string' || !input.directory.trim() || input.directory.length > 4096
    || (input.noteText !== undefined && (typeof input.noteText !== 'string' || input.noteText.length > 3000))
    || (input.todos !== undefined && (!Array.isArray(input.todos) || input.todos.length > 500))) {
    throw new ContextInputError('invalid workspace import', 400);
  }
  const todos = input.todos as unknown[] | undefined;
  const ids = new Set<string>();
  for (const item of todos ?? []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ContextInputError('invalid workspace todo', 400);
    const todo = item as Record<string, unknown>;
    if (typeof todo.id !== 'string' || !todo.id || todo.id.length > 200 || ids.has(todo.id)
      || typeof todo.text !== 'string' || !todo.text.trim() || todo.text.length > 120 || typeof todo.done !== 'boolean') {
      throw new ContextInputError('invalid workspace todo', 400);
    }
    ids.add(todo.id);
  }
  if (!(typeof input.noteText === 'string' && input.noteText.trim()) && !todos?.length) {
    throw new ContextInputError('no workspace content to import', 400);
  }
  return input as unknown as WorkspaceImportInput;
}

function checkedStoredNotes(context: ProjectContext): ProjectNote[] {
  const ids = new Set<string>();
  return context.notes.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as ProjectNote).id !== 'string' || !(value as ProjectNote).id
      || ids.has((value as ProjectNote).id) || typeof (value as ProjectNote).body !== 'string') {
      throw new Error('malformed stored note');
    }
    ids.add((value as ProjectNote).id);
    return value as ProjectNote;
  });
}

function checkedStoredTodos(context: ProjectContext): ProjectTodo[] {
  const normalized = validateProjectTodos(context.todos);
  if (normalized.some((todo, index) => {
    const original = context.todos[index] as Partial<ProjectTodo>;
    return typeof original.completed !== 'boolean' || !Number.isSafeInteger(original.createdAt)
      || original.createdAt! < 0 || todo.id !== original.id;
  })) throw new Error('malformed stored todo');
  return context.todos as ProjectTodo[];
}

export async function importWorkspaceContext(projectId: string, raw: unknown): Promise<{
  context: ProjectContext; importedNotes: number; importedTodos: number;
}> {
  const input = checkInput(raw);
  return mutateProjectContext(projectId, (current) => {
    const notes = checkedStoredNotes(current);
    const todos = checkedStoredTodos(current);
    const noteText = input.noteText?.trim() ? input.noteText : undefined;
    // Bind the import to the source file, not its contents: a changed source
    // must conflict instead of silently creating a second General note.
    const noteId = noteText ? importId('note', input.directory, '.opencode/nnd/general-notes.md') : null;
    const previousNote = noteId ? notes.find((note) => note.id === noteId) : undefined;
    if (previousNote && previousNote.body !== noteText) throw new ContextInputError('workspace import ID conflict', 409);
    const now = Date.now();
    const newNote: ProjectNote | null = noteText && !previousNote ? {
      id: noteId!, body: noteText, createdAt: now, updatedAt: now, source: 'manual',
    } : null;
    const todoIds = new Map(todos.map((todo) => [todo.id, todo]));
    const newTodos: ProjectTodo[] = [];
    for (const legacy of input.todos ?? []) {
      const id = importId('todo', input.directory, legacy.id);
      const previous = todoIds.get(id);
      if (previous) {
        if (previous.text !== legacy.text || previous.completed !== legacy.done) {
          throw new ContextInputError('workspace todo changed since an earlier import', 409);
        }
        continue;
      }
      const todo = { id, text: legacy.text, completed: legacy.done, createdAt: now };
      newTodos.push(todo); todoIds.set(id, todo);
    }
    if (notes.length + (newNote ? 1 : 0) > 200 || todos.length + newTodos.length > 500) {
      throw new ContextInputError('project context limit reached', 400);
    }
    const next: ProjectContext = { ...current, notes: newNote ? [...notes, newNote] : notes,
      todos: newTodos.length ? [...todos, ...newTodos] : todos };
    return { next, result: { context: next, importedNotes: newNote ? 1 : 0, importedTodos: newTodos.length } };
  });
}
