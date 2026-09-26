// SPDX-License-Identifier: Apache-2.0
/** P9-3d loop files (doc 12 C.8): frontmatter parse/defaults/failures,
 * scope shadowing + nearest-ancestor precedence, deterministic ids, the
 * file-driven task inputs (adoption/rename carrying unknown fields, state),
 * the enabled toggle rewrite, and the locked reconciliation table. */
import { describe, expect, it, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath, sep } from 'node:path';
import type { DiscoveredLoop } from '../scheduled/loops.ts';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p93d-loops-`);
process.env.NOTNATIVE_DATA_DIR = ROOT;
const T0 = Date.UTC(2026, 8, 26, 9, 0, 0); // Sat 2026-09-26 09:00Z
const OPT = { now: T0, serverZone: 'UTC' };

const loopsMod = await import('../scheduled/loops.ts');
const configMod = await import('../scheduled/task-config.ts');

const { discoverLoops, parseLoopFile, loopTaskId, loopTaskInput, writeLoopEnabled, projectLoopAncestors } = loopsMod;
const { loadScheduledTasks, reconcileLoopTasks, scheduledConfigPath } = configMod;

function writeLoop(dir: string, name: string, meta: Record<string, string>, body: string): string {
  mkdirSync(dir, { recursive: true });
  const lines = ['---', ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`), '---', body];
  const file = joinPath(dir, `${name}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function seedConfig(projectId: string, doc: unknown): void {
  mkdirSync(joinPath(ROOT, 'projects'), { recursive: true });
  writeFileSync(scheduledConfigPath(projectId), JSON.stringify(doc, null, 2));
}

function loopDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'loop:project:daily', name: 'daily', enabled: false,
    loopFile: 'C:/loops/daily.md',
    schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
    execution: { prompt: 'Run', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: T0 - 1000, updatedAt: T0 - 1000, lastStatus: 'idle', lastRunAt: 111 },
    ...patch,
  };
}

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: T0, updatedAt: T0, lastStatus: 'idle' },
    ...patch,
  };
}

const storedTask = (projectId: string) => loadScheduledTasks(projectId, OPT).then((t) => t.tasks);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('parseLoopFile (C.8 format)', () => {
  it('parses a full frontmatter document with quotes, agent, and zone', () => {
    const text = [
      '---', 'name: daily-digest', 'schedule: "0 9 * * *"', 'enabled: true',
      'model: anthropic/claude-sonnet-4-5', 'agent: plan', 'timezone: Europe/Kyiv', '---',
      '', 'Summarize repository changes since yesterday.', '',
    ].join('\n');
    const parsed = parseLoopFile(text, OPT);
    expect(parsed.definition).not.toBeNull();
    expect(parsed.definition?.name).toBe('daily-digest');
    expect(parsed.definition?.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *', timezone: 'Europe/Kyiv' });
    expect(parsed.definition?.execution).toEqual({
      prompt: 'Summarize repository changes since yesterday.',
      providerID: 'anthropic', modelID: 'claude-sonnet-4-5', agent: 'plan',
    });
    expect(parsed.definition?.enabled).toBe(true);
  });

  it('defaults enabled to FALSE and splits the model on the FIRST slash', () => {
    const text = ['---', 'name: one-two', 'schedule: 30 8 * * *', 'model: a/b/c', '---', 'Body'].join('\n');
    const parsed = parseLoopFile(text, OPT);
    expect(parsed.definition?.enabled).toBe(false);
    expect(parsed.definition?.execution.providerID).toBe('a');
    expect(parsed.definition?.execution.modelID).toBe('b/c');
  });

  it('rejects the enumerated failures without blocking anything else', () => {
    const parse = (meta: string[], body = 'Body') =>
      parseLoopFile(['---', ...meta, '---', body].join('\n'), OPT);
    expect(parseLoopFile('no frontmatter', OPT).definition).toBeNull();
    expect(parse([]).definition).toBeNull(); // no name, no schedule, no model
    expect(parse(['name: x'.replace('x', 'a'.repeat(81)), 'model: a/b', 'schedule: 0 8 * * *']).definition).toBeNull();
    expect(parse(['name: has space', 'model: a/b', 'schedule: 0 8 * * *']).definition).toBeNull();
    expect(parse(['name: daily', 'model: a/b', 'schedule: nope * * * *']).definition).toBeNull();
    expect(parse(['name: daily', 'model: a/b', 'schedule: 99 8 * * *']).definition).toBeNull();
    expect(parse(['name: daily', 'schedule: 0 8 * * *']).definition).toBeNull();
    expect(parse(['name: daily', 'model: noprovider', 'schedule: 0 8 * * *']).definition).toBeNull();
    expect(parse(['name: daily', 'model: a/b', 'schedule: 0 8 * * *'], '').definition).toBeNull();
  });

  it('keeps a usable name on field failures (definition null, reason set)', () => {
    const text = ['---', 'name: broken', 'model: a/b', 'schedule: junk', '---', 'Body'].join('\n');
    const parsed = parseLoopFile(text, OPT);
    expect(parsed.definition).toBeNull();
    expect(parsed.reason).toMatch(/cron/iu);
  });

  it('falls back an unknown zone to the server zone and ignores UI-only keys', () => {
    const text = ['---', 'name: zoned', 'schedule: 0 8 * * 1', 'model: a/b', 'timezone: Nope/Nowhere',
      'goalEnabled: true', 'goalTokenBudget: 500', 'permissionAutoAccept: true', '---', 'Body'].join('\n');
    const parsed = parseLoopFile(text, OPT);
    expect(parsed.definition?.schedule.timezone).toBe('UTC');
    expect(parsed.definition?.execution).not.toHaveProperty('goalEnabled');
    expect(parsed.definition?.execution).not.toHaveProperty('variant');
  });
});

describe('loop ids and task inputs (deterministic identity)', () => {
  const file = 'C:/loops/daily.md';
  const loop = (): DiscoveredLoop => ({
    name: 'daily', file, scope: 'project',
    definition: { name: 'daily', schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
      execution: { prompt: 'Body', providerID: 'a', modelID: 'b' }, enabled: false },
  });

  it('derives `loop:<scope>:<name>` and rebuilds a fresh task document', () => {
    const found = loop();
    expect(loopTaskId(found)).toBe('loop:project:daily');
    const input = loopTaskInput(found, { stored: null });
    expect(input).toMatchObject({
      id: 'loop:project:daily', name: 'daily', enabled: false, loopFile: file,
      schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
      execution: { prompt: 'Body', providerID: 'a', modelID: 'b' },
    });
  });

  it('carries unknown fields, execution extras, and state through the file-owned keys', () => {
    const found = loop();
    const stored = {
      id: 'hand', name: 'daily', enabled: true, customTag: 'keep-me',
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      execution: { prompt: 'old', providerID: 'a', modelID: 'b', variant: 'v5', goalEnabled: true, goalTokenBudget: 900 },
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', lastSessionId: 's-9' },
    };
    const input = loopTaskInput(found, { stored, id: 'hand' });
    expect(input.id).toBe('hand');
    expect(input.customTag).toBe('keep-me');
    expect(input.state).toEqual(stored.state);
    expect(input.enabled).toBe(false); // the file owns the toggle
    expect(input.execution).toMatchObject({ prompt: 'Body', providerID: 'a', modelID: 'b', variant: 'v5', goalEnabled: true });
    expect(input.loopFile).toBe(file);
  });
});

describe('writeLoopEnabled (PATCH loop-file rewrite)', () => {
  it('rewrites the existing flag and appends when absent', () => {
    const withFlag = ['---', 'name: x', 'enabled: false', 'schedule: 0 8 * * *', '---', 'Body'].join('\n');
    expect(writeLoopEnabled(withFlag, true)).toBe(['---', 'name: x', 'enabled: true', 'schedule: 0 8 * * *', '---', 'Body'].join('\n'));
    const without = ['---', 'name: y', 'schedule: 0 8 * * *', '---', 'Body'].join('\n');
    const appended = ['---', 'name: y', 'schedule: 0 8 * * *', 'enabled: false', '---', 'Body'];
    expect(writeLoopEnabled(without, false)).toBe(appended.join('\n'));
    expect(writeLoopEnabled('plain text', true)).toBeNull();
  });
});

describe('projectLoopAncestors + discoverLoops (scope precedence)', () => {
  it('walks up to the containing worktree root; gitless paths reach the fs root', () => {
    mkdirSync(joinPath(ROOT, 'repo', '.git'), { recursive: true });
    mkdirSync(joinPath(ROOT, 'repo', 'deep', 'path'), { recursive: true });
    const deep = joinPath(ROOT, 'repo', 'deep', 'path');
    const inRepo = projectLoopAncestors(deep);
    expect(inRepo[0]).toBe(deep);
    expect(inRepo[inRepo.length - 1]).toBe(joinPath(ROOT, 'repo'));
    mkdirSync(joinPath(ROOT, 'plain', 'deep', 'path'), { recursive: true });
    const gitless = projectLoopAncestors(joinPath(ROOT, 'plain', 'deep', 'path'));
    expect(gitless).toContain(ROOT);
    const last = gitless[gitless.length - 1] ?? '';
    expect(dirname(last)).toBe(last); // the walk ended at the filesystem root
  });

  it('project scope shadows user scope; the nearest ancestor wins', async () => {
    const userDir = joinPath(ROOT, 'user-loops');
    writeLoop(userDir, 'shared', { name: 'shared', schedule: '0 7 * * *', model: 'u/m' }, 'user body');
    writeLoop(userDir, 'only-user', { name: 'only-user', schedule: '0 7 * * *', model: 'u/m' }, 'user body');
    const repoDir = joinPath(ROOT, 'repo2');
    const parentDir = joinPath(repoDir, 'proj');
    writeLoop(joinPath(repoDir, '.agents', 'loops'), 'shared', { name: 'shared', schedule: '0 6 * * *', model: 'r/m' }, 'repo body');
    writeLoop(joinPath(parentDir, '.agents', 'loops'), 'shared', { name: 'shared', schedule: '0 5 * * *', model: 'p/m' }, 'nearest body');
    writeLoop(joinPath(parentDir, '.agents', 'loops'), 'nearest', { name: 'nearest', schedule: '0 4 * * *', model: 'p/m' }, 'body');
    const found = await discoverLoops(parentDir, OPT, userDir);
    const byName = new Map(found.map((loop) => [loop.name, loop]));
    expect(byName.get('shared')?.file).toBe(joinPath(parentDir, '.agents', 'loops', 'shared.md'));
    expect(byName.get('shared')?.definition?.schedule.cron).toBe('0 5 * * *');
    expect(byName.get('only-user')?.scope).toBe('user');
    expect(byName.get('nearest')?.scope).toBe('project');
    expect(byName.get('missing-nearest-root')).toBeUndefined();
  });

  it('a parse-failed named file reports definition null; a nameless file vanishes', async () => {
    const dir = joinPath(ROOT, 'broken-loops');
    writeLoop(dir, 'badcron', { name: 'badcron', schedule: 'junk', model: 'a/b' }, 'body');
    writeFileSync(joinPath(dir, 'noname.md'), ['---', 'schedule: 0 8 * * *', 'model: a/b', '---', 'Body'].join('\n'));
    const found = await discoverLoops(null, OPT, dir);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('badcron');
    expect(found[0]?.definition).toBeNull();
    expect(found[0]?.reason).toMatch(/cron/iu);
  });
});

describe('reconcileLoopTasks (C.8 table, inside the project lock)', () => {
  const PID = 'loopy';
  const loopDir = joinPath(ROOT, 'reconcile', '.agents', 'loops');
  const discovered = (file: string, name: string, enabled: boolean, cron = '0 8 * * *'): DiscoveredLoop => ({
    name, file, scope: 'project',
    definition: { name, schedule: { kind: 'cron', cron, timezone: 'UTC' },
      execution: { prompt: 'Loop body', providerID: 'a', modelID: 'b' }, enabled },
  });

  it('creates a deterministic file-driven task and keeps sibling config keys', async () => {
    seedConfig(PID, { version: 1, notes: 'keep', scheduledTasks: [taskDoc()] });
    const file = writeLoop(loopDir, 'digest', { name: 'digest', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    await reconcileLoopTasks(PID, [discovered(file, 'digest', false)], OPT);
    const tasks = await storedTask(PID);
    expect(tasks).toHaveLength(2);
    const loopTask = tasks.find((t) => t.id === 'loop:project:digest');
    expect(loopTask?.loopFile).toBe(file);
    expect(loopTask).toMatchObject({
      name: 'digest', enabled: false,
      schedule: { kind: 'cron', cron: '0 8 * * *' },
      execution: { prompt: 'Loop body', providerID: 'a', modelID: 'b' },
    });
    const doc = JSON.parse(readFileSync(scheduledConfigPath(PID), 'utf8')) as Record<string, unknown>;
    expect(doc.notes).toBe('keep');
    expect(doc.version).toBe(1);
  });

  it('renames the task owning the file path (identity = file, state survives)', async () => {
    const file = writeLoop(loopDir, 'digest2', { name: 'digest2', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    seedConfig(PID, { scheduledTasks: [loopDoc({
      id: 'loop:project:digest2', loopFile: file, name: 'digest2',
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', lastRunAt: 42 },
    })] });
    // the file's name field changes -> the task owning the path is re-keyed
    writeLoop(loopDir, 'digest2', { name: 'digest2b', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    await reconcileLoopTasks(PID, [discovered(file, 'digest2b', false)], OPT);
    const tasks = await storedTask(PID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('loop:project:digest2b');
    expect(tasks[0]?.state.lastRunAt).toBe(42);
    expect(tasks[0]?.loopFile).toBe(file);
  });

  it('adopts a name-colliding plain task with id, state, and UI-only fields', async () => {
    const file = writeLoop(loopDir, 'daily', { name: 'daily', schedule: '30 8 * * *', model: 'a/b' }, 'Loop body');
    seedConfig(PID, { scheduledTasks: [{ ...taskDoc({
      id: 'hand-made', name: 'daily',
      execution: { prompt: 'old', providerID: 'a', modelID: 'b', variant: 'v5', goalEnabled: true, goalTokenBudget: 500 },
    }), unknownTop: 'keep' }] });
    await reconcileLoopTasks(PID, [discovered(file, 'daily', true, '30 8 * * *')], OPT);
    const tasks = await storedTask(PID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('hand-made');
    expect(tasks[0]?.unknownTop).toBe('keep');
    expect(tasks[0]?.loopFile).toBe(file);
    expect(tasks[0]?.enabled).toBe(true);
    expect(tasks[0]?.execution).toMatchObject({
      prompt: 'Loop body', providerID: 'a', modelID: 'b', variant: 'v5', goalEnabled: true, goalTokenBudget: 500,
    });
  });

  it('drops a loop task whose file vanished and never touches plain tasks', async () => {
    seedConfig(PID, { scheduledTasks: [
      loopDoc({ id: 'loop:project:gone', loopFile: 'X:/nowhere/gone.md' }),
      taskDoc(),
    ] });
    await reconcileLoopTasks(PID, [], OPT);
    const tasks = await storedTask(PID);
    expect(tasks.map((t) => t.id)).toEqual(['task-1']);
  });

  it('keeps the last good definition while the file exists but is broken', async () => {
    const loneDir = joinPath(ROOT, 'lone-loops');
    const file = writeLoop(loneDir, 'keepme', { name: 'keepme', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    seedConfig(PID, { scheduledTasks: [loopDoc({
      id: 'loop:project:keepme', loopFile: file, name: 'keepme',
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', nextRunAt: 99 },
    })] });
    writeLoop(loneDir, 'keepme', { name: 'keepme', schedule: 'junk', model: 'a/b' }, 'Loop body');
    const broken = (await discoverLoops(null, OPT, loneDir))[0];
    expect(broken?.definition).toBeNull();
    await reconcileLoopTasks(PID, [broken as DiscoveredLoop], OPT);
    const tasks = await storedTask(PID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.schedule).toEqual({ kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' });
    expect(tasks[0]?.state.nextRunAt).toBe(99); // untouched: no write happened
  });

  it('prunes duplicated pointers; the first pointer survives', async () => {
    const file = writeLoop(loopDir, 'dup', { name: 'dup', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    seedConfig(PID, { scheduledTasks: [
      loopDoc({ id: 'loop:project:dup', loopFile: file, name: 'dup' }),
      loopDoc({ id: 'stale-owner', loopFile: file, name: 'dup' }),
    ] });
    await reconcileLoopTasks(PID, [discovered(file, 'dup', false)], OPT);
    const tasks = await storedTask(PID);
    expect(tasks.map((t) => t.id)).toEqual(['loop:project:dup']);
  });

  it('writes nothing when discovery is empty or nothing changed', async () => {
    mkdirSync(joinPath(ROOT, 'projects'), { recursive: true });
    const pid = 'still';
    seedConfig(pid, { notes: 'plain', scheduledTasks: [taskDoc()] });
    const before = readFileSync(scheduledConfigPath(pid), 'utf8');
    await reconcileLoopTasks(pid, [], OPT);
    expect(readFileSync(scheduledConfigPath(pid), 'utf8')).toBe(before);
    const file = writeLoop(loopDir, 'still', { name: 'still', schedule: '0 8 * * *', model: 'a/b' }, 'Loop body');
    await reconcileLoopTasks(pid, [discovered(file, 'still', false)], OPT);
    const after = readFileSync(scheduledConfigPath(pid), 'utf8');
    expect(after).not.toBe(before);
    const tasks = await storedTask(pid);
    expect(tasks.some((t) => t.id === 'loop:project:still')).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});
