// SPDX-License-Identifier: Apache-2.0
/** Validation for whole-list project-context todo writes. */
import { ContextInputError } from './context-store.ts';

export interface ProjectTodo { id: string; text: string; completed: boolean; createdAt: number }

export function validateProjectTodos(value: unknown): ProjectTodo[] {
  if (!Array.isArray(value) || value.length > 500) throw new ContextInputError('todos must be an array of at most 500 items', 400);
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ContextInputError('invalid todo', 400);
    const todo = entry as Partial<ProjectTodo>;
    if (typeof todo.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(todo.id) || ids.has(todo.id)
      || typeof todo.text !== 'string' || !todo.text.trim() || todo.text.length > 120
      || (todo.completed !== undefined && typeof todo.completed !== 'boolean')
      || (todo.createdAt !== undefined && (typeof todo.createdAt !== 'number' || !Number.isSafeInteger(todo.createdAt) || todo.createdAt < 0))) {
      throw new ContextInputError('invalid todo', 400);
    }
    ids.add(todo.id);
    return { id: todo.id, text: todo.text, completed: todo.completed ?? false, createdAt: todo.createdAt ?? Date.now() };
  });
}
