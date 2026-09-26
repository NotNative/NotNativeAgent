// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'nnd-p10-plans-'));
process.env.NOTNATIVE_DATA_DIR = dataDir;
let registerProjectsRoutes: typeof import('../routes/projects.ts').registerProjectsRoutes;
beforeAll(async () => { ({ registerProjectsRoutes } = await import('../routes/projects.ts')); });
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function app(): Hono { const instance = new Hono(); registerProjectsRoutes(instance); return instance; }
function json(body: unknown, method: string): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('P10 personal plan storage', () => {
  it('creates markdown before manifest, reads raw, updates verbatim, then deletes manifest and file', async () => {
    const api = app();
    const config = join(dataDir, 'projects', 'alpha.json');
    mkdirSync(join(dataDir, 'projects'), { recursive: true });
    writeFileSync(config, JSON.stringify({ actions: ['build'] }));
    const before = readFileSync(config, 'utf8');
    const created = await api.request('/api/project-context/alpha/plans', json({ title: 'Launch', body: 'Steps' }, 'POST'));
    expect(created.status).toBe(201);
    const payload = await created.json() as { plan: { id: string; file: string }; context: { plans: unknown[] } };
    expect(payload.context.plans).toHaveLength(1);
    const file = join(dataDir, 'projects', 'alpha', 'plans', payload.plan.file);
    expect(readFileSync(file, 'utf8')).toBe('# Launch\n\nSteps\n');
    const read = await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ title: 'Launch', body: 'Steps', raw: '# Launch\n\nSteps\n' });
    const updated = await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`,
      json({ raw: '# Changed\n\nRaw **markdown**' }, 'PUT'));
    expect(updated.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('# Changed\n\nRaw **markdown**');
    expect(await (await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`)).json()).toMatchObject({
      title: 'Changed', body: 'Raw **markdown**',
    });
    expect((await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`,
      json({ raw: '  \n' }, 'PUT'))).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('  \n');
    expect((await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`,
      json({ raw: '' }, 'PUT'))).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('');
    const removed = await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { plans: unknown[] }).plans).toEqual([]);
    expect((await api.request(`/api/project-context/alpha/plans/${payload.plan.id}`)).status).toBe(404);
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('refuses missing files and path-shaped stored links without recreating or escaping', async () => {
    const api = app();
    const folder = join(dataDir, 'projects', 'bad', 'plans');
    mkdirSync(folder, { recursive: true });
    const context = join(dataDir, 'projects', 'bad', 'context.json');
    writeFileSync(context, JSON.stringify({ version: 2, notes: [], todos: [], plans: [
      { id: 'p1', file: '../outside.md', title: 'Unsafe', createdAt: 1 },
    ] }));
    expect((await api.request('/api/project-context/bad/plans/p1')).status).toBe(500);
    expect((await api.request('/api/project-context/bad/plans', json({ title: 'Safe', body: '' }, 'POST'))).status).toBe(500);
    writeFileSync(context, JSON.stringify({ version: 2, notes: [], todos: [], plans: [
      { id: 'p1', file: 'missing.md', title: 'Missing', createdAt: 1 },
    ] }));
    expect((await api.request('/api/project-context/bad/plans/p1')).status).toBe(404);
    expect((await api.request('/api/project-context/bad/plans/p1', json({ raw: 'Test' }, 'PUT'))).status).toBe(404);
    expect((await api.request('/api/project-context/bad/plans/p1', { method: 'DELETE' })).status).toBe(200);
  });

  it('refuses duplicate IDs and file links before deleting any markdown or manifest', async () => {
    const api = app();
    const folder = join(dataDir, 'projects', 'duplicates', 'plans');
    mkdirSync(folder, { recursive: true });
    const context = join(dataDir, 'projects', 'duplicates', 'context.json');
    const first = { id: 'a', file: 'first.md', title: 'First', createdAt: 1 };
    const second = { id: 'a', file: 'second.md', title: 'Second', createdAt: 2 };
    writeFileSync(join(folder, 'first.md'), 'first');
    writeFileSync(join(folder, 'second.md'), 'second');
    for (const duplicate of [second, { ...second, id: 'b', file: 'first.md' },
      { ...second, id: 'b', file: 'FIRST.md' }]) {
      writeFileSync(context, JSON.stringify({ version: 2, notes: [], todos: [], plans: [first, duplicate] }));
      expect((await api.request('/api/project-context/duplicates/plans/a', { method: 'DELETE' })).status).toBe(500);
      expect(existsSync(join(folder, 'first.md'))).toBe(true);
      expect(existsSync(join(folder, 'second.md'))).toBe(true);
      expect(JSON.parse(readFileSync(context, 'utf8')).plans).toHaveLength(2);
    }
  });

  it('refuses a linked plans directory without creating or reading files outside the project', async () => {
    const api = app();
    const project = join(dataDir, 'projects', 'linked');
    const outside = join(dataDir, 'outside-plans');
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'external.md'), 'secret');
    symlinkSync(outside, join(project, 'plans'), 'junction');
    writeFileSync(join(project, 'context.json'), JSON.stringify({ version: 2, notes: [], todos: [], plans: [
      { id: 'external', file: 'external.md', title: 'External', createdAt: 1 },
    ] }));
    expect((await api.request('/api/project-context/linked/plans/external')).status).toBe(500);
    expect((await api.request('/api/project-context/linked/plans', json({ title: 'New', body: 'body' }, 'POST'))).status).toBe(500);
    expect((await api.request('/api/project-context/linked/plans/external', json({ raw: 'changed' }, 'PUT'))).status).toBe(500);
    expect(readFileSync(join(outside, 'external.md'), 'utf8')).toBe('secret');
    expect(JSON.parse(readFileSync(join(project, 'context.json'), 'utf8')).plans).toHaveLength(1);
  });

  it('rejects multiline titles and keeps legacy manifest entries usable', async () => {
    const api = app();
    const project = join(dataDir, 'projects', 'legacy');
    const folder = join(project, 'plans');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'old.md'), '# Old\n\nLegacy body');
    writeFileSync(join(dataDir, 'projects', 'legacy.json'), JSON.stringify({ plans: [
      { id: 'old', file: 'old.md', title: 'Old', createdAt: 1 },
    ] }));
    expect(await (await api.request('/api/project-context/legacy/plans/old')).json()).toMatchObject({
      title: 'Old', body: 'Legacy body', raw: '# Old\n\nLegacy body',
    });
    expect((await api.request('/api/project-context/legacy/plans',
      json({ title: 'Injected\n# Heading', body: 'body' }, 'POST'))).status).toBe(400);
    expect((await api.request('/api/project-context/legacy/plans',
      json({ title: 'New', body: 'body' }, 'POST'))).status).toBe(201);
    expect((JSON.parse(readFileSync(join(project, 'context.json'), 'utf8')) as { plans: unknown[] }).plans).toHaveLength(2);
    expect(readFileSync(join(folder, 'old.md'), 'utf8')).toBe('# Old\n\nLegacy body');
  });
});
