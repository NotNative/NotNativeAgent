// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'nnd-p10-legacy-durable-'));
process.env.NOTNATIVE_DATA_DIR = dataDir;
let readProjectContext: typeof import('../project-context/context-store.ts').readProjectContext;
let replaceProjectTodos: typeof import('../project-context/context-store.ts').replaceProjectTodos;

beforeAll(async () => {
  ({ readProjectContext, replaceProjectTodos } = await import('../project-context/context-store.ts'));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function prepare(name: string, value: unknown): string {
  const folder = join(dataDir, 'projects', name);
  mkdirSync(folder, { recursive: true });
  const path = join(dataDir, 'projects', `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('P10-64 durable legacy context migration', () => {
  it('projects a legacy-only note without rewriting the config', async () => {
    const configPath = prepare('legacy-string', {
      actions: ['build'], projectNotes: 'Legacy note',
      projectTodos: [{ id: 'one', text: 'Do work', completed: true }],
      projectPlanFiles: [], scheduledTasks: [{ id: 'keep' }], unrelated: { deep: 1 },
    });
    const contextPath = join(dataDir, 'projects', 'legacy-string', 'context.json');
    const first = await readProjectContext('legacy-string');
    expect(first).toMatchObject({
      version: 2,
      notes: [{ body: 'Legacy note', source: 'manual' }],
      todos: [{ id: 'one', text: 'Do work', completed: true }],
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      actions: ['build'], projectNotes: 'Legacy note',
      projectTodos: [{ id: 'one', text: 'Do work', completed: true }],
      projectPlanFiles: [], scheduledTasks: [{ id: 'keep' }], unrelated: { deep: 1 },
    });
    await expect(readProjectContext('legacy-string')).resolves.toEqual(first);
    expect(existsSync(contextPath)).toBe(false);
  });

  it('treats empty legacy notes as no note without consuming project todo arrays', async () => {
    const configPath = prepare('empty-note', { projectNotes: '', reasoning: true,
      projectTodos: [{ id: 'two', text: 'Ship it', completed: false }] });
    const context = await readProjectContext('empty-note');
    expect(context).toEqual({
      version: 2, notes: [], todos: [{ id: 'two', text: 'Ship it', completed: false }], plans: [],
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      projectNotes: '', reasoning: true,
      projectTodos: [{ id: 'two', text: 'Ship it', completed: false }],
    });
  });

  it('converges concurrent reads without consuming legacy keys', async () => {
    prepare('concurrent', { projectNotes: 'Racing note', projectTodos: [], projectPlanFiles: [] });
    const [first, second, third] = await Promise.all([
      readProjectContext('concurrent'), readProjectContext('concurrent'), readProjectContext('concurrent'),
    ]);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first.notes).toMatchObject([{ body: 'Racing note', source: 'manual' }]);
    expect(readFileSync(join(dataDir, 'projects', 'concurrent.json'), 'utf8')).toContain('projectNotes');
    expect(existsSync(join(dataDir, 'projects', 'concurrent', 'context.json'))).toBe(false);
    await expect(readProjectContext('concurrent')).resolves.toEqual(first);
  });

  it('removes both legacy alias conflicts atomically only after a context write', async () => {
    const legacy = {
      notes: [{ body: 'Array note' }], projectNotes: 'String note',
      todos: [{ id: 'todo-array' }], projectTodos: [{ id: 'todo-project' }], keep: ['me'],
    };
    const configPath = prepare('conflicting', legacy);
    const original = readFileSync(configPath, 'utf8');
    await expect(readProjectContext('conflicting')).rejects.toThrow('conflicting legacy');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(existsSync(join(dataDir, 'projects', 'conflicting', 'context.json'))).toBe(false);
    await expect(replaceProjectTodos('conflicting', [])).rejects.toThrow('conflicting legacy');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('leaves malformed legacy values and unrelated keys completely untouched', async () => {
    const legacy = { projectNotes: 'Wait', projectTodos: { not: 'an array' }, unrelated: new Date().getTime() > 0 };
    const configPath = prepare('malformed-todos', legacy);
    const original = readFileSync(configPath, 'utf8');
    await expect(readProjectContext('malformed-todos')).rejects.toThrow('malformed project context');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(existsSync(join(dataDir, 'projects', 'malformed-todos', 'context.json'))).toBe(false);
  });

  it('keeps unrelated values while config PUT preserves deferred legacy keys', async () => {
    const { registerProjectsRoutes } = await import('../routes/projects.ts');
    const app = new Hono();
    registerProjectsRoutes(app);
    prepare('put-consistency', { projectNotes: 'Put note', unrelated: { value: 2 } });
    const put = async (body: unknown) => app.request('/api/projects/put-consistency/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await put({ actions: ['review'], projectNotes: 'Put note' })).status).toBe(200);
    expect((await put({ actions: ['review'] })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, 'projects', 'put-consistency.json'), 'utf8')))
      .toEqual({ actions: ['review'], projectNotes: 'Put note' });
    await expect(readProjectContext('put-consistency')).resolves.toMatchObject({
      notes: [{ body: 'Put note' }],
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'projects', 'put-consistency.json'), 'utf8')))
      .toEqual({ actions: ['review'], projectNotes: 'Put note' });
  });
});
