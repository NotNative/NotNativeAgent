// SPDX-License-Identifier: Apache-2.0
/** Typed HTTP boundary for NND-owned project context; never reads repo files. */
import { runtimeFetch } from './runtime-fetch.ts';

export interface ProjectNote {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: 'manual' | 'selection' | 'agent';
  origin?: { sessionId: string; messageId: string };
  pinned?: boolean;
}
export interface ProjectContext {
  version: 2;
  notes: ProjectNote[];
  todos: unknown[];
  plans: unknown[];
  todosRevision?: string;
}
export interface ProjectTodo { id: string; text: string; completed: boolean; createdAt: number }
export interface ProjectPlan {
  id: string; file: string; title: string; createdAt: number;
  pinned?: boolean; source?: string; body?: string; raw?: string;
}

function endpoint(projectId: string, suffix = ''): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(projectId)) throw new Error('Invalid project ID');
  return `/api/project-context/${encodeURIComponent(projectId)}${suffix}`;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await runtimeFetch(path, init);
  if (!response.ok) throw new ProjectContextRequestError(response.status);
  return response.json() as Promise<unknown>;
}

export class ProjectContextRequestError extends Error {
  constructor(readonly status: number) { super(`Project context request failed (${status})`); }
}

function parseContext(value: unknown): ProjectContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid project context response');
  const doc = value as Partial<ProjectContext>;
  if (doc.version !== 2 || !Array.isArray(doc.notes) || !Array.isArray(doc.todos) || !Array.isArray(doc.plans)) {
    throw new Error('Invalid project context response');
  }
  return doc as ProjectContext;
}

function notePath(projectId: string, noteId: string): string {
  if (!noteId || noteId.includes('/') || noteId.includes('\\')) throw new Error('Invalid note ID');
  return endpoint(projectId, `/notes/${encodeURIComponent(noteId)}`);
}

export async function getProjectContext(projectId: string): Promise<ProjectContext> {
  return parseContext(await request(endpoint(projectId)));
}

export async function createProjectNote(projectId: string, input: {
  body: string; source?: ProjectNote['source']; origin?: ProjectNote['origin'];
}): Promise<{ note: ProjectNote; context: ProjectContext }> {
  const value = await request(endpoint(projectId, '/notes'), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const payload = value as { note?: ProjectNote; context?: unknown };
  if (!payload || !payload.note || typeof payload.note.id !== 'string') throw new Error('Invalid note response');
  return { note: payload.note, context: parseContext(payload.context) };
}

export async function updateProjectNote(projectId: string, noteId: string, input: {
  body?: string; pinned?: boolean;
}): Promise<ProjectNote> {
  const value = await request(notePath(projectId, noteId), { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const note = (value as { note?: ProjectNote })?.note;
  if (!note || typeof note.id !== 'string') throw new Error('Invalid note response');
  return note;
}

export async function deleteProjectNote(projectId: string, noteId: string): Promise<ProjectContext> {
  return parseContext(await request(notePath(projectId, noteId), { method: 'DELETE' }));
}

export async function replaceProjectTodos(projectId: string, todos: ProjectTodo[], expectedRevision: string): Promise<ProjectContext> {
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new Error('Invalid todo revision');
  return parseContext(await request(endpoint(projectId, '/todos'), { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ todos, expectedRevision }) }));
}

function planPath(projectId: string, planId: string): string {
  if (!planId || planId.includes('/') || planId.includes('\\')) throw new Error('Invalid plan ID');
  return endpoint(projectId, `/plans/${encodeURIComponent(planId)}`);
}

export async function getProjectPlan(projectId: string, planId: string): Promise<ProjectPlan> {
  const value = await request(planPath(projectId, planId));
  const plan = value as ProjectPlan;
  if (!plan || typeof plan.id !== 'string' || typeof plan.raw !== 'string') throw new Error('Invalid plan response');
  return plan;
}

export async function createProjectPlan(projectId: string, input: { title: string; body: string }): Promise<{
  plan: ProjectPlan; context: ProjectContext;
}> {
  const value = await request(endpoint(projectId, '/plans'), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const payload = value as { plan?: ProjectPlan; context?: unknown };
  if (!payload?.plan || typeof payload.plan.id !== 'string') throw new Error('Invalid plan response');
  return { plan: payload.plan, context: parseContext(payload.context) };
}

export async function updateProjectPlan(projectId: string, planId: string, raw: string): Promise<{
  plan: ProjectPlan; raw: string;
}> {
  const value = await request(planPath(projectId, planId), { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });
  const payload = value as { plan?: ProjectPlan; raw?: unknown };
  if (!payload?.plan || typeof payload.plan.id !== 'string' || typeof payload.raw !== 'string') {
    throw new Error('Invalid plan response');
  }
  return { plan: payload.plan, raw: payload.raw };
}

export async function deleteProjectPlan(projectId: string, planId: string): Promise<ProjectContext> {
  return parseContext(await request(planPath(projectId, planId), { method: 'DELETE' }));
}
