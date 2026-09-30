// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../runtime-fetch.ts';
import { createProjectNote, deleteProjectNote, getProjectContext,
  replaceProjectTodos, updateProjectNote, createProjectPlan, getProjectPlan,
  updateProjectPlan, deleteProjectPlan } from '../project-context-api.ts';

const empty = { version: 2, notes: [], todos: [], plans: [] };
beforeEach(() => vi.mocked(runtimeFetch).mockReset());

function answer(value: unknown, status = 200): void {
  vi.mocked(runtimeFetch).mockResolvedValue({ ok: status < 400, status, json: async () => value } as Response);
}

describe('project context HTTP boundary', () => {
  it('loads only authoritative context and rejects malformed/error responses', async () => {
    answer(empty);
    await expect(getProjectContext('project1')).resolves.toEqual(empty);
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/project1', undefined);
    answer({ version: 2, notes: [], todos: [] });
    await expect(getProjectContext('project1')).rejects.toThrow('Invalid project context response');
    answer({}, 500);
    await expect(getProjectContext('project1')).rejects.toThrow('500');
    await expect(getProjectContext('../other')).rejects.toThrow('Invalid project ID');
  });

  it('keeps HTTP-missing and malformed-authoritative failures separate', async () => {
    answer({ message: 'project not found' }, 404);
    await expect(getProjectContext('missing')).rejects.toThrow('Project context request failed (404)');
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/missing', undefined);
    answer({ version: 2, notes: [], todos: [] });
    await expect(getProjectContext('malformed')).rejects.toThrow('Invalid project context response');
    expect(runtimeFetch).toHaveBeenLastCalledWith('/api/project-context/malformed', undefined);
  });

  it('uses note and todo routes with explicit methods and committed response shapes', async () => {
    const note = { id: 'n1', body: 'Body', createdAt: 1, updatedAt: 1, source: 'manual' };
    answer({ note, context: { ...empty, notes: [note] } });
    await expect(createProjectNote('p1', { body: 'Body' })).resolves.toMatchObject({ note });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/p1/notes', expect.objectContaining({ method: 'POST' }));
    answer({ note: { ...note, body: 'Edit' } });
    await expect(updateProjectNote('p1', 'n1', { body: 'Edit' })).resolves.toMatchObject({ body: 'Edit' });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/p1/notes/n1', expect.objectContaining({ method: 'PATCH' }));
    answer(empty);
    await expect(deleteProjectNote('p1', 'n1')).resolves.toEqual(empty);
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/p1/notes/n1', { method: 'DELETE' });
    const todo = { id: 't1', text: 'Task', completed: false, createdAt: 1 };
    answer({ ...empty, todos: [todo] });
    const revision = 'a'.repeat(64);
    await expect(replaceProjectTodos('p1', [todo], revision)).resolves.toMatchObject({ todos: [todo] });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/p1/todos', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse((vi.mocked(runtimeFetch).mock.lastCall?.[1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: revision, todos: [todo],
    });
  });

  it('sends pin patches without a body, preserving note text isolation', async () => {
    const note = { id: 'n1', body: 'Body', createdAt: 1, updatedAt: 1, source: 'manual' };
    answer({ note });
    await expect(updateProjectNote('p1', 'n1', { pinned: true })).resolves.toEqual(note);
    const init = vi.mocked(runtimeFetch).mock.lastCall?.[1] as RequestInit;
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(init.body as string)).toEqual({ pinned: true });
    answer({ message: 'gone' }, 404);
    await expect(updateProjectNote('p1', 'n1', { body: 'Edit' })).rejects.toThrow('Project context request failed (404)');
  });

  it('uses saved-plan routes without accepting malformed authoritative responses', async () => {
    const plan = { id: 'p1', file: 'p1.md', title: 'Plan', createdAt: 1 };
    answer({ plan, context: { ...empty, plans: [plan] } });
    await expect(createProjectPlan('project1', { title: 'Plan', body: 'Body' })).resolves.toMatchObject({ plan });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/project1/plans', expect.objectContaining({ method: 'POST' }));
    answer({ ...plan, raw: '# Plan\n\nBody' });
    await expect(getProjectPlan('project1', 'p1')).resolves.toMatchObject({ raw: '# Plan\n\nBody' });
    answer({ plan, raw: '' });
    await expect(updateProjectPlan('project1', 'p1', '')).resolves.toMatchObject({ raw: '' });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/project-context/project1/plans/p1', expect.objectContaining({ method: 'PUT' }));
    answer(empty);
    await expect(deleteProjectPlan('project1', 'p1')).resolves.toEqual(empty);
    answer({ plan });
    await expect(getProjectPlan('project1', 'p1')).rejects.toThrow('Invalid plan response');
  });
});
