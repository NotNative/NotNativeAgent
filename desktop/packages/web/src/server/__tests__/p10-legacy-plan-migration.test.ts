// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'nnd-p10-legacy-plan-'));
process.env.NOTNATIVE_DATA_DIR = dataDir;
let readProjectContext: typeof import('../project-context/context-store.ts').readProjectContext;
let replaceProjectTodos: typeof import('../project-context/context-store.ts').replaceProjectTodos;
beforeAll(async () => {
  ({ readProjectContext, replaceProjectTodos } = await import('../project-context/context-store.ts'));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('P10 legacy plan-link migration', () => {
  it('copies an in-store absolute plan link, preserves context, and cleans legacy keys only after commit', async () => {
    const root = join(dataDir, 'projects');
    mkdirSync(root, { recursive: true });
    const source = join(root, 'old-plan.md');
    writeFileSync(source, '# Legacy\n\nBody');
    const configPath = join(root, 'project1.json');
    writeFileSync(configPath, JSON.stringify({ actions: ['build'], scheduledTasks: [{ id: 'task' }],
      projectNotes: 'Keep note', projectTodos: [{ id: 't1' }],
      projectPlanFiles: [{ id: 'p1', path: source, createdAt: 10 }] }));
    const context = await readProjectContext('project1');
    expect(context.notes).toMatchObject([{ body: 'Keep note' }]);
    expect(context.todos).toEqual([{ id: 't1' }]);
    expect(context.plans).toMatchObject([{ id: 'p1', title: 'Legacy', createdAt: 10, source: 'personal' }]);
    const file = (context.plans[0] as { file: string }).file;
    expect(readFileSync(join(root, 'project1', 'plans', file), 'utf8')).toBe('# Legacy\n\nBody');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ actions: ['build'], scheduledTasks: [{ id: 'task' }] });
    expect(await readProjectContext('project1')).toEqual(context);
    expect(await replaceProjectTodos('project1', [{ id: 't2' }])).toMatchObject({ plans: context.plans, todos: [{ id: 't2' }] });
  });

  it('drops missing markdown but refuses out-of-store links without writing context', async () => {
    const root = join(dataDir, 'projects');
    const missing = join(root, 'gone.md');
    writeFileSync(join(root, 'missing.json'), JSON.stringify({ projectNotes: 'Kept',
      projectPlanFiles: [{ id: 'gone', path: missing, createdAt: 1 }] }));
    const context = await readProjectContext('missing');
    expect(context.plans).toEqual([]);
    expect(context.notes).toMatchObject([{ body: 'Kept' }]);
    const outside = join(dataDir, 'secret.md');
    writeFileSync(outside, '# Private');
    const unsafeConfig = join(root, 'unsafe.json');
    writeFileSync(unsafeConfig, JSON.stringify({ projectPlanFiles: [{ id: 'private', path: outside }] }));
    await expect(readProjectContext('unsafe')).rejects.toThrow('leaves project storage');
    expect(existsSync(join(root, 'unsafe', 'context.json'))).toBe(false);
    expect(readFileSync(unsafeConfig, 'utf8')).toContain('projectPlanFiles');
    writeFileSync(join(root, 'missing-outside.json'), JSON.stringify({
      projectPlanFiles: [{ id: 'outside', path: join(dataDir, 'absent.md') }],
    }));
    await expect(readProjectContext('missing-outside')).rejects.toThrow('leaves project storage');
    expect(existsSync(join(root, 'missing-outside', 'context.json'))).toBe(false);
  });

  it('refuses a linked destination without reading it or committing the manifest', async () => {
    const root = join(dataDir, 'projects');
    const source = join(root, 'source-for-symlink.md');
    writeFileSync(source, '# Safe');
    const file = `legacy-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.md`;
    const plans = join(root, 'linked-destination', 'plans');
    mkdirSync(plans, { recursive: true });
    const secret = join(dataDir, 'linked-secret-directory');
    mkdirSync(secret);
    writeFileSync(join(secret, 'private.md'), '# Private');
    symlinkSync(secret, join(plans, file), 'junction');
    const config = join(root, 'linked-destination.json');
    writeFileSync(config, JSON.stringify({ projectPlanFiles: [{ id: 'p1', path: source }] }));
    await expect(readProjectContext('linked-destination')).rejects.toThrow('unsafe legacy plan destination');
    expect(existsSync(join(root, 'linked-destination', 'context.json'))).toBe(false);
    expect(readFileSync(join(secret, 'private.md'), 'utf8')).toBe('# Private');
    expect(readFileSync(config, 'utf8')).toContain('projectPlanFiles');
  });

  it('refuses unsafe existing plan entries before deleting legacy config fields', async () => {
    const root = join(dataDir, 'projects');
    const source = join(root, 'base-validation.md');
    writeFileSync(source, '# Safe');
    const config = join(root, 'unsafe-base.json');
    writeFileSync(config, JSON.stringify({ plans: [{ id: 'old', file: '../secret.md' }],
      projectPlanFiles: [{ id: 'new', path: source }] }));
    await expect(readProjectContext('unsafe-base')).rejects.toThrow('ambiguous legacy plan manifest');
    expect(existsSync(join(root, 'unsafe-base', 'context.json'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toContain('projectPlanFiles');
  });

  it('does not rewrite malformed UTF-8 markdown during migration', async () => {
    const root = join(dataDir, 'projects');
    const source = join(root, 'invalid-utf8.md');
    writeFileSync(source, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
    const config = join(root, 'invalid-utf8.json');
    writeFileSync(config, JSON.stringify({ projectPlanFiles: [{ id: 'bad', path: source }] }));
    await expect(readProjectContext('invalid-utf8')).rejects.toThrow();
    expect(existsSync(join(root, 'invalid-utf8', 'context.json'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toContain('projectPlanFiles');
  });
});
