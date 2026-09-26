// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'nnd-p10-context-'));
process.env.NOTNATIVE_DATA_DIR = dataDir;
let readProjectContext: typeof import('../project-context/context-store.ts').readProjectContext;
let replaceProjectTodos: typeof import('../project-context/context-store.ts').replaceProjectTodos;

beforeAll(async () => {
  ({ readProjectContext, replaceProjectTodos } = await import('../project-context/context-store.ts'));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('P10 separate project context store', () => {
  it('distinguishes an absent context from malformed stored JSON', async () => {
    await expect(readProjectContext('empty')).resolves.toEqual({ version: 2, notes: [], todos: [], plans: [] });
    const folder = join(dataDir, 'projects', 'broken');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'context.json'), '{bad');
    await expect(readProjectContext('broken')).rejects.toThrow();
    await expect(replaceProjectTodos('broken', [])).rejects.toThrow();
    expect(readFileSync(join(folder, 'context.json'), 'utf8')).toBe('{bad');
    const incomplete = join(dataDir, 'projects', 'incomplete');
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(incomplete, 'context.json'), JSON.stringify({ version: 2, notes: [], todos: [] }));
    await expect(replaceProjectTodos('incomplete', [{ id: 'new' }])).rejects.toThrow('incomplete project context');
    expect(readFileSync(join(incomplete, 'context.json'), 'utf8')).not.toContain('new');
    const { registerProjectsRoutes } = await import('../routes/projects.ts');
    const app = new Hono();
    registerProjectsRoutes(app);
    expect((await app.request('/api/project-context/broken')).status).toBe(500);
    expect((await app.request('/api/project-context/broken/todos', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ todos: [] }) })).status).toBe(500);
  });

  it('seeds the isolated file from legacy arrays without overwriting general config', async () => {
    const folder = join(dataDir, 'projects');
    mkdirSync(folder, { recursive: true });
    const configPath = join(folder, 'legacy.json');
    const config = { actions: ['build'], notes: [{ id: 'n1', body: 'Keep me' }],
      todos: [{ id: 'old' }], plans: [{ id: 'p1' }], scheduledTasks: [{ id: 'scheduled' }] };
    writeFileSync(configPath, JSON.stringify(config));
    await expect(readProjectContext('legacy')).resolves.toMatchObject({ notes: config.notes, plans: config.plans });
    const committed = await replaceProjectTodos('legacy', [{ id: 'new' }]);
    expect(committed).toMatchObject({ version: 2, notes: config.notes, plans: config.plans, todos: [{ id: 'new' }] });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config);
    expect(JSON.parse(readFileSync(join(folder, 'legacy', 'context.json'), 'utf8'))).toEqual(committed);
    await expect(readProjectContext('legacy')).resolves.toEqual(committed);
  });

  it('retains a legacy note string and refuses to hide unmigrated plan files', async () => {
    const folder = join(dataDir, 'projects');
    writeFileSync(join(folder, 'old-note.json'), JSON.stringify({ projectNotes: 'Keep this note' }));
    const first = await readProjectContext('old-note');
    const second = await readProjectContext('old-note');
    expect(first).toEqual(second);
    expect(first.notes).toMatchObject([{ body: 'Keep this note', source: 'manual' }]);
    writeFileSync(join(folder, 'old-plan.json'), JSON.stringify({ projectPlanFiles: ['C:\\legacy\\plan.md'] }));
    await expect(readProjectContext('old-plan')).rejects.toThrow('malformed legacy plan link');
    await expect(replaceProjectTodos('old-plan', [])).rejects.toThrow('malformed legacy plan link');
    expect(readFileSync(join(folder, 'old-plan.json'), 'utf8')).toContain('projectPlanFiles');
    writeFileSync(join(folder, 'mixed-plan.json'), JSON.stringify({
      plans: [{ id: 'new-plan' }], projectPlanFiles: ['C:\\legacy\\old-plan.md'],
    }));
    await expect(readProjectContext('mixed-plan')).rejects.toThrow('malformed legacy plan link');
    await expect(replaceProjectTodos('mixed-plan', [])).rejects.toThrow('malformed legacy plan link');
    expect(readFileSync(join(folder, 'mixed-plan.json'), 'utf8')).toContain('projectPlanFiles');
  });

  it('uses nonempty legacy aliases and refuses ambiguous values', async () => {
    const folder = join(dataDir, 'projects');
    writeFileSync(join(folder, 'empty-alias.json'), JSON.stringify({
      notes: [], projectNotes: 'Keep this note', todos: [], projectTodos: [{ id: 'keep' }],
    }));
    await expect(readProjectContext('empty-alias')).resolves.toMatchObject({
      notes: [{ body: 'Keep this note' }], todos: [{ id: 'keep' }],
    });
    writeFileSync(join(folder, 'ambiguous-alias.json'), JSON.stringify({
      notes: [{ body: 'One' }], projectNotes: 'Two', todos: [{ id: 'one' }], projectTodos: [{ id: 'two' }],
    }));
    await expect(readProjectContext('ambiguous-alias')).rejects.toThrow('conflicting legacy');
    await expect(replaceProjectTodos('ambiguous-alias', [])).rejects.toThrow('conflicting legacy');
    expect(readFileSync(join(folder, 'ambiguous-alias.json'), 'utf8')).toContain('projectNotes');
  });

  it('retains additional version-2 fields when replacing todos', async () => {
    const folder = join(dataDir, 'projects', 'extended');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'context.json'), JSON.stringify({
      version: 2, notes: [], todos: [], plans: [], sharedPlansDir: 'plans', extra: { nested: true },
    }));
    const committed = await replaceProjectTodos('extended', [{ id: 'new' }]);
    expect(committed).toMatchObject({ sharedPlansDir: 'plans', extra: { nested: true } });
    expect(JSON.parse(readFileSync(join(folder, 'context.json'), 'utf8'))).toEqual(committed);
  });

  it('keeps legacy fields through config PUT until context is seeded', async () => {
    const { registerProjectsRoutes } = await import('../routes/projects.ts');
    const app = new Hono();
    registerProjectsRoutes(app);
    const folder = join(dataDir, 'projects');
    const configPath = join(folder, 'config-migration.json');
    const legacy = { projectNotes: 'Keep note', projectTodos: [{ id: 'old' }],
      projectPlanFiles: [], scheduledTasks: [{ id: 'scheduled' }] };
    writeFileSync(configPath, JSON.stringify(legacy));
    const put = (body: unknown) => app.request('/api/projects/config-migration/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await put({ actions: ['build'] })).status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ ...legacy, actions: ['build'] });
    expect((await put({ actions: ['bad'], projectNotes: 'Changed' })).status).toBe(400);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ ...legacy, actions: ['build'] });
    expect((await put({ actions: ['next'], projectNotes: legacy.projectNotes })).status).toBe(200);
    await replaceProjectTodos('config-migration', [{ id: 'new' }]);
    expect((await put({ actions: ['after-seed'] })).status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ actions: ['after-seed'], scheduledTasks: legacy.scheduledTasks });
    await expect(readProjectContext('config-migration')).resolves.toMatchObject({
      notes: [{ body: legacy.projectNotes }], todos: [{ id: 'new' }],
    });
  });

  it('rejects traversal-shaped project IDs before any file access', async () => {
    await expect(readProjectContext('../other')).rejects.toThrow('invalid project ID');
    await expect(replaceProjectTodos('..', [])).rejects.toThrow('invalid project ID');
  });

  it('creates, edits, and deletes notes without touching project config', async () => {
    const { registerProjectsRoutes } = await import('../routes/projects.ts');
    const app = new Hono();
    registerProjectsRoutes(app);
    const configPath = join(dataDir, 'projects', 'note-flow.json');
    writeFileSync(configPath, JSON.stringify({ actions: ['build'], projectNotes: 'Legacy note' }));
    const before = readFileSync(configPath, 'utf8');
    const create = await app.request('/api/project-context/note-flow/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '  New note  ', source: 'selection', origin: { sessionId: 's1', messageId: 'm1' } }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { note: { id: string; body: string; updatedAt: number }; context: { notes: unknown[] } };
    expect(created.note.body).toBe('New note');
    expect(created.context.notes).toHaveLength(2);
    const id = created.note.id;
    const pinned = await app.request(`/api/project-context/note-flow/notes/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true, source: 'agent' }),
    });
    expect(pinned.status).toBe(200);
    expect((await pinned.json() as { note: { pinned: boolean; source: string; updatedAt: number } }).note)
      .toMatchObject({ pinned: true, source: 'selection', updatedAt: created.note.updatedAt });
    const edit = await app.request(`/api/project-context/note-flow/notes/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Edited' }),
    });
    expect(edit.status).toBe(200);
    expect((await edit.json() as { note: { body: string; pinned: boolean } }).note)
      .toMatchObject({ body: 'Edited', pinned: true });
    const removed = await app.request(`/api/project-context/note-flow/notes/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { notes: unknown[] }).notes).toHaveLength(1);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect((await readProjectContext('note-flow')).notes).toHaveLength(1);
  });

  it('rejects invalid note changes and leaves the file unchanged', async () => {
    const { registerProjectsRoutes } = await import('../routes/projects.ts');
    const app = new Hono();
    registerProjectsRoutes(app);
    const post = (body: unknown) => app.request('/api/project-context/note-bad/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({ body: 'Valid', source: 'unknown' })).status).toBe(400);
    expect((await post({ body: 'Valid', origin: { sessionId: 1 } })).status).toBe(400);
    expect((await post({ body: 'Valid', origin: null })).status).toBe(400);
    expect((await post({ body: 'Valid', origin: [] })).status).toBe(400);
    expect((await app.request('/api/project-context/note-bad/notes/missing', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Test' }),
    })).status).toBe(404);
    expect((await app.request('/api/project-context/note-bad/notes/missing', { method: 'DELETE' })).status).toBe(404);
    await expect(readProjectContext('note-bad')).resolves.toMatchObject({ notes: [] });
  });
});
