// SPDX-License-Identifier: Apache-2.0
/** Isolated project context storage; legacy config is read-only input. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';

export interface ProjectContext {
  version: 2;
  notes: unknown[];
  todos: unknown[];
  plans: unknown[];
  [key: string]: unknown;
}

export interface ProjectNote {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: 'manual' | 'selection' | 'agent';
  origin?: { sessionId: string; messageId: string };
  pinned?: boolean;
}

export class ContextInputError extends Error {
  constructor(message: string, readonly status: 400 | 404) { super(message); }
}

const PROJECT_ID = /^[A-Za-z0-9_-]+$/u;

export function projectContextPaths(projectId: string): { config: string; context: string; plans: string } {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid project ID');
  const root = join(ENV.dataDir, 'projects');
  return { config: join(root, `${projectId}.json`), context: join(root, projectId, 'context.json'),
    plans: join(root, projectId, 'plans') };
}

async function readOptional(path: string): Promise<unknown | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed project context');
  return value as Record<string, unknown>;
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('malformed project context');
  return value;
}

function legacyNotes(config: Record<string, unknown>): unknown[] {
  const notes = config.notes;
  const projectNotes = config.projectNotes;
  if (notes !== undefined && !Array.isArray(notes) && typeof notes !== 'string') throw new Error('malformed legacy notes');
  if (projectNotes !== undefined && typeof projectNotes !== 'string') throw new Error('malformed legacy notes');
  const hasNotes = Array.isArray(notes) ? notes.length > 0 : notes !== undefined && notes !== '';
  if (hasNotes && projectNotes) throw new Error('conflicting legacy notes');
  if (Array.isArray(notes) && hasNotes) return notes;
  const body = projectNotes || notes;
  if (body === undefined || body === '') return [];
  if (Array.isArray(body)) return body;
  if (typeof body !== 'string') throw new Error('malformed legacy notes');
  const id = `legacy-${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
  return [{ id, body, createdAt: 0, updatedAt: 0, source: 'manual' }];
}

function fromLegacy(value: unknown): ProjectContext {
  if (value === undefined) return { version: 2, notes: [], todos: [], plans: [] };
  const config = asObject(value);
  const planFiles = asList(config.projectPlanFiles);
  if (planFiles.length > 0) throw new Error('legacy plan files require migration');
  const todos = asList(config.todos);
  const projectTodos = asList(config.projectTodos);
  if (todos.length > 0 && projectTodos.length > 0) throw new Error('conflicting legacy todos');
  return { version: 2, notes: legacyNotes(config), todos: todos.length > 0 ? todos : projectTodos,
    plans: asList(config.plans) };
}

function parseContext(value: unknown): ProjectContext {
  const doc = asObject(value);
  if (doc.version !== 2) throw new Error('unsupported project context version');
  if (doc.notes === undefined || doc.todos === undefined || doc.plans === undefined) {
    throw new Error('incomplete project context');
  }
  return { ...doc, version: 2, notes: asList(doc.notes), todos: asList(doc.todos), plans: asList(doc.plans) };
}

/** Missing is empty; malformed files fail visibly so clients keep their prior state. */
export async function readProjectContext(projectId: string): Promise<ProjectContext> {
  const target = projectContextPaths(projectId);
  const stored = await readOptional(target.context);
  if (stored !== undefined) return parseContext(stored);
  return fromLegacy(await readOptional(target.config));
}

async function commitContext(target: ReturnType<typeof projectContextPaths>, next: ProjectContext): Promise<void> {
  await mkdir(dirname(target.context), { recursive: true });
  const temp = `${target.context}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target.context);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
  }
}

/** Serialize all context mutations with project config writers. */
export async function mutateProjectContext<T>(projectId: string, change: (current: ProjectContext) =>
  Promise<{ next: ProjectContext; result: T }> | { next: ProjectContext; result: T }): Promise<T> {
  const target = projectContextPaths(projectId);
  return withConfigLock(target.config, async () => {
    const current = await readProjectContext(projectId);
    const { next, result } = await change(current);
    await commitContext(target, next);
    return result;
  });
}

export async function replaceProjectTodos(projectId: string, todos: unknown[]): Promise<ProjectContext> {
  return mutateProjectContext(projectId, (current) => {
    const next = { ...current, todos };
    return { next, result: next };
  });
}

function checkedNotes(context: ProjectContext): ProjectNote[] {
  return context.notes.map((value) => {
    const note = asObject(value);
    if (typeof note.id !== 'string' || !note.id || typeof note.body !== 'string') {
      throw new Error('malformed stored note');
    }
    return note as unknown as ProjectNote;
  });
}

function checkedBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContextInputError('note body must not be blank', 400);
  return value.trim().slice(0, 3000);
}

export async function createProjectNote(projectId: string, input: {
  body?: unknown; source?: unknown; origin?: unknown;
}): Promise<{ note: ProjectNote; context: ProjectContext }> {
  const body = checkedBody(input.body);
  const source = input.source === undefined ? 'manual' : input.source;
  if (source !== 'manual' && source !== 'selection' && source !== 'agent') {
    throw new ContextInputError('invalid note source', 400);
  }
  let origin: ProjectNote['origin'];
  if (input.origin !== undefined) {
    const value = input.origin;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as Record<string, unknown>).sessionId !== 'string'
      || typeof (value as Record<string, unknown>).messageId !== 'string') {
      throw new ContextInputError('invalid note origin', 400);
    }
    const fields = value as Record<string, string>;
    origin = { sessionId: fields.sessionId!, messageId: fields.messageId! };
  }
  return mutateProjectContext(projectId, (current) => {
    const notes = checkedNotes(current);
    if (notes.length >= 200) throw new ContextInputError('project note limit reached', 400);
    const now = Date.now();
    const note: ProjectNote = { id: randomUUID(), body, createdAt: now, updatedAt: now, source, ...(origin ? { origin } : {}) };
    const context = { ...current, notes: [...notes, note] };
    return { next: context, result: { note, context } };
  });
}

export async function updateProjectNote(projectId: string, noteId: string, input: { body?: unknown; pinned?: unknown }): Promise<ProjectNote> {
  if (input.body === undefined && input.pinned === undefined) throw new ContextInputError('no note fields supplied', 400);
  const body = input.body === undefined ? undefined : checkedBody(input.body);
  if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw new ContextInputError('invalid pinned value', 400);
  return mutateProjectContext(projectId, (current) => {
    const notes = checkedNotes(current);
    const index = notes.findIndex((note) => note.id === noteId);
    if (index < 0) throw new ContextInputError('note not found', 404);
    const note: ProjectNote = { ...notes[index]!, ...(body === undefined ? {} : { body, updatedAt: Date.now() }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned as boolean }) };
    const next = [...notes];
    next[index] = note;
    return { next: { ...current, notes: next }, result: note };
  });
}

export async function deleteProjectNote(projectId: string, noteId: string): Promise<ProjectContext> {
  return mutateProjectContext(projectId, (current) => {
    const notes = checkedNotes(current);
    const index = notes.findIndex((note) => note.id === noteId);
    if (index < 0) throw new ContextInputError('note not found', 404);
    const next = { ...current, notes: notes.filter((note) => note.id !== noteId) };
    return { next, result: next };
  });
}
