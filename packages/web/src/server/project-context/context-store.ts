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

const PROJECT_ID = /^[A-Za-z0-9_-]+$/u;

function paths(projectId: string): { config: string; context: string } {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid project ID');
  const root = join(ENV.dataDir, 'projects');
  return { config: join(root, `${projectId}.json`), context: join(root, projectId, 'context.json') };
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
  const target = paths(projectId);
  const stored = await readOptional(target.context);
  if (stored !== undefined) return parseContext(stored);
  return fromLegacy(await readOptional(target.config));
}

/** Serialize with project config writers while seeding the separate context file. */
export async function replaceProjectTodos(projectId: string, todos: unknown[]): Promise<ProjectContext> {
  const target = paths(projectId);
  return withConfigLock(target.config, async () => {
    const current = await readProjectContext(projectId);
    const next: ProjectContext = { ...current, todos };
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
    return next;
  });
}
