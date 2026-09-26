// SPDX-License-Identifier: Apache-2.0
/** P9-3d audit reproductions (adversarial pass over the loop slice):
 * the adopted-id re-key rule (E-09-23 f), the loop-ownership gate axes
 * (id/file, not just name), the settings-family config-PUT write lock
 * (C.9), CRLF preservation in the loop-file toggle rewrite, plus pins for
 * behaviors investigated and judged registered/correct. */
import { describe, expect, it, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { Hono } from 'hono';
import type { RuntimePorts, PipelineOutcome } from '../scheduled/scheduled-runtime.ts';
import type { DiscoveredLoop } from '../scheduled/loops.ts';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p93d-audit-`);
process.env.NOTNATIVE_DATA_DIR = ROOT;
const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);
const OPT = { now: T0, serverZone: 'UTC' };

const { writeLoopEnabled, discoverLoops, parseLoopFile } = await import('../scheduled/loops.ts');
const { reconcileLoopTasks, scheduledConfigPath, loadScheduledTasks } = await import('../scheduled/task-config.ts');
const { createScheduledTaskRoutes } = await import('../routes/scheduled-tasks.ts');
const { registerProjectsRoutes } = await import('../routes/projects.ts');
const { createScheduledTasksRuntime } = await import('../scheduled/scheduled-runtime.ts');
const { createScheduledStorePorts, scheduledNormalizeOptions } = await import('../scheduled/scheduled-service.ts');
const { acquireConfigLock } = await import('../scheduled/config-lock.ts');

const USER_LOOPS = joinPath(ROOT, 'user-loops'); // absent: user scope empty
const projectDir = joinPath(ROOT, 'worktree');
const dirs = new Map<string, string>();
let runtime: ReturnType<typeof createScheduledTasksRuntime> | null = null;

function makeRuntime(): ReturnType<typeof createScheduledTasksRuntime> {
  const ports: RuntimePorts = {
    ...createScheduledStorePorts(),
    listProjects: async () => readdirSync(joinPath(ROOT, 'projects'))
      .filter((entry: string) => entry.endsWith('.json')).map((entry: string) => entry.slice(0, -5)),
    runPipeline: async (): Promise<PipelineOutcome> => ({ sessionID: 'sess-audit' }),
    emit: () => {},
    log: { warn: () => {}, error: () => {} },
    now: () => T0,
    jitter: () => 0,
    normalizeOptions: scheduledNormalizeOptions(),
    loopsFor: (projectId) => dirs.get(projectId) !== undefined
      ? discoverLoops(dirs.get(projectId) as string, scheduledNormalizeOptions(), USER_LOOPS)
      : Promise.resolve(null),
    reconcileLoops: async (projectId, loops) => {
      await reconcileLoopTasks(projectId, [...loops], OPT);
    },
  };
  return createScheduledTasksRuntime(ports);
}

function buildApp(): Hono {
  runtime = makeRuntime();
  const loopsFor = async (projectId: string): Promise<readonly DiscoveredLoop[] | null> =>
    dirs.get(projectId) !== undefined
      ? discoverLoops(dirs.get(projectId) as string, scheduledNormalizeOptions(), USER_LOOPS)
      : null;
  return new Hono().route('/', createScheduledTaskRoutes(() => runtime, { loopsFor }));
}

const plainApp = new Hono();
registerProjectsRoutes(plainApp);
const call = (a: Hono) => async (path: string, init?: RequestInit): Promise<Response> =>
  a.fetch(new Request(`http://t.audit${path}`, { headers: { 'content-type': 'application/json' }, ...init })) as Promise<Response>;

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: T0, updatedAt: T0, lastStatus: 'idle' },
    ...patch,
  };
}

function loopTaskDoc(file: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...taskDoc({ id: 'loop:project:daily', name: 'daily', enabled: false, loopFile: file }),
    state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', lastRunAt: 42 },
    ...patch,
  };
}

function seedConfig(projectId: string, doc: unknown): void {
  mkdirSync(joinPath(ROOT, 'projects'), { recursive: true });
  writeFileSync(scheduledConfigPath(projectId), JSON.stringify(doc, null, 2));
}

function writeLoopFile(project: string, stem: string, name: string, meta: Record<string, string> = {}, enabled = 'false'): string {
  const dir = joinPath(project, '.agents', 'loops');
  mkdirSync(dir, { recursive: true });
  const file = joinPath(dir, `${stem}.md`);
  writeFileSync(file, ['---', `name: ${name}`, 'schedule: 0 8 * * *', `enabled: ${enabled}`,
    ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`), 'model: a/b', '---', 'Loop body', ''].join('\n'));
  return file;
}

const discovered = (file: string, name: string, enabled = false): DiscoveredLoop => ({
  name, file, scope: 'project',
  definition: { name, schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
    execution: { prompt: 'Loop body', providerID: 'a', modelID: 'b' }, enabled },
});

afterEach(() => { runtime?.stop(); runtime = null; dirs.clear(); });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('fix A: the adopted hand-made id survives a no-change reconcile', () => {
  it('keeps the stored id and never rewrites the document (E-09-23 f)', async () => {
    const PID = 'adopt-keep';
    const file = writeLoopFile(joinPath(ROOT, 'adopt'), 'daily', 'daily');
    seedConfig(PID, { notes: 'k', scheduledTasks: [taskDoc({
      id: 'hand-made', name: 'daily',
      execution: { prompt: 'old', providerID: 'a', modelID: 'b', variant: 'v5' },
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', lastRunAt: 42 },
    })] });
    await reconcileLoopTasks(PID, [discovered(file, 'daily', true)], OPT);
    const afterAdoption = await loadScheduledTasks(PID, OPT);
    expect(afterAdoption.tasks[0]?.id).toBe('hand-made'); // adoption keeps the id
    expect(afterAdoption.tasks[0]?.loopFile).toBe(file);
    const bytes = readFileSync(scheduledConfigPath(PID), 'utf8');
    await reconcileLoopTasks(PID, [discovered(file, 'daily', true)], OPT); // no changes since
    const afterAgain = await loadScheduledTasks(PID, OPT);
    expect(afterAgain.tasks.map((t) => t.id)).toEqual(['hand-made']); // still the hand-made id
    expect(afterAgain.tasks[0]?.state.lastRunAt).toBe(42);
    expect(readFileSync(scheduledConfigPath(PID), 'utf8')).toBe(bytes); // no per-sync churn
  });

  it('still re-keys on a real rename and walks the memory timer with it', async () => {
    const PID = 'rename-shed';
    const file = writeLoopFile(joinPath(ROOT, 'shed'), 'mine', 'mine', {}, 'true');
    seedConfig(PID, { scheduledTasks: [{
      ...taskDoc({ id: 'loop:project:mine', name: 'mine', enabled: true, loopFile: file }),
      schedule: { kind: 'cron', cron: '59 23 * * *', timezone: 'UTC' },
      state: { createdAt: 5, updatedAt: 6, lastStatus: 'success', lastRunAt: 42 },
    }] });
    dirs.set(PID, joinPath(ROOT, 'shed'));
    const rt = makeRuntime();
    runtime = rt;
    await rt.syncProject(PID);
    expect([...rt.internals.tasksByProject.get(PID)?.keys() ?? []]).toEqual(['loop:project:mine']);
    const timerCount = rt.internals.timers.size;
    expect(timerCount).toBe(1); // armed for the deterministic id
    writeLoopFile(joinPath(ROOT, 'shed'), 'mine', 'renamed', {}, 'true'); // same path, new name field
    await rt.syncProject(PID);
    const keys = [...(rt.internals.tasksByProject.get(PID)?.keys() ?? [])];
    expect(keys).toEqual(['loop:project:renamed']);
    expect([...rt.internals.timers.keys()]).toEqual([`${PID}:loop:project:renamed`]); // old timer shed
    const after = await loadScheduledTasks(PID, OPT);
    expect(after.tasks[0]?.id).toBe('loop:project:renamed');
    expect(after.tasks[0]?.state.lastRunAt).toBe(42);
    expect(after.tasks[0]?.loopFile).toBe(file);
  });
});

describe('fix B: the upsert gate refuses every loop identity axis (id and file, not just name)', () => {
  it('refuses a loop-shaped id whose file exists while the name is different', async () => {
    const PID = 'gate-id';
    writeLoopFile(projectDir, 'taken', 'taken');
    dirs.set(PID, projectDir);
    seedConfig(PID, { scheduledTasks: [] });
    const api = call(buildApp());
    const put = await api('/api/projects/gate-id/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({
        task: taskDoc({ id: 'loop:project:taken', name: 'Other Name' }),
      }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toMatch(/loop file/iu);
    expect((await loadScheduledTasks(PID, OPT)).tasks).toHaveLength(0); // nothing written, no sync hijack
  });

  it('refuses a task carrying a present loop file path with a foreign name', async () => {
    const PID = 'gate-file';
    const file = writeLoopFile(projectDir, 'owned', 'owned');
    dirs.set(PID, projectDir);
    seedConfig(PID, { scheduledTasks: [] });
    const api = call(buildApp());
    const put = await api('/api/projects/gate-file/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({
        task: taskDoc({ id: 'fresh-1', name: 'New Name', loopFile: file }),
      }),
    });
    expect(put.status).toBe(400);
    expect((await loadScheduledTasks(PID, OPT)).tasks.map((t) => t.id)).toEqual([]); // not re-keyed away
  });

  it('an orphan loop task stays writable with discovery active (no over-refusal)', async () => {
    const PID = 'orphan-ok';
    writeLoopFile(projectDir, 'other', 'other');
    dirs.set(PID, projectDir);
    seedConfig(PID, { scheduledTasks: [{
      ...taskDoc({ id: 'orphan-x', name: 'Old', loopFile: joinPath(ROOT, 'gone.md') }),
    }] });
    const api = call(buildApp());
    const put = await api('/api/projects/orphan-ok/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({ task: taskDoc({ id: 'orphan-x', name: 'Repaired' }) }),
    });
    expect(put.status).toBe(200);
    const after = await loadScheduledTasks(PID, OPT);
    expect(after.tasks[0]?.id).toBe('orphan-x');
    expect(after.tasks[0]?.name).toBe('Repaired');
    expect(after.tasks[0]?.loopFile).toBeUndefined(); // upsert dropped the dead marker
  });
});

describe('fix C: the settings-family config PUT serializes with the task store (C.9)', () => {
  it('defers while the project config lock is held and preserves scheduledTasks', async () => {
    const PID = 'cfglock';
    seedConfig(PID, { notes: 'old', scheduledTasks: [taskDoc()] });
    const api = call(plainApp);
    const lock = await acquireConfigLock(scheduledConfigPath(PID));
    const outcome = { settled: false, status: 0, fault: '' };
    const pending = api('/api/projects/cfglock/config', {
      method: 'PUT', body: JSON.stringify({ actions: ['a1'] }),
    }).then((kept) => {
      outcome.settled = true;
      outcome.status = kept.status;
    }, (error: unknown) => { outcome.settled = true; outcome.fault = String(error); });
    for (let i = 0; i < 10 && !outcome.settled; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(outcome.settled).toBe(false); // a locked reader must not write around the lock
    lock.release();
    await pending;
    expect(outcome.fault).toBe('');
    expect(outcome.status).toBe(200);
    const doc = JSON.parse(readFileSync(scheduledConfigPath(PID), 'utf8')) as Record<string, unknown>;
    expect(doc.actions).toEqual(['a1']);
    expect((doc.scheduledTasks as unknown[]).length).toBe(1); // the store's key rode through
  });

  it('PUT todos defers under the same lock and keeps both keys (same C.9 class)', async () => {
    const PID = 'cfglock';
    seedConfig(PID, { notes: 'old', scheduledTasks: [taskDoc()] });
    const api = call(plainApp);
    const lock = await acquireConfigLock(scheduledConfigPath(PID));
    const outcome = { settled: false, status: 0, fault: '' };
    const pending = api('/api/project-context/cfglock/todos', {
      method: 'PUT', body: JSON.stringify({ todos: ['t1'] }),
    }).then((kept) => {
      outcome.settled = true;
      outcome.status = kept.status;
    }, (error: unknown) => { outcome.settled = true; outcome.fault = String(error); });
    for (let i = 0; i < 10 && !outcome.settled; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(outcome.settled).toBe(false); // a locked writer must not write around the lock
    lock.release();
    await pending;
    expect(outcome.fault).toBe('');
    expect(outcome.status).toBe(200);
    const doc = JSON.parse(readFileSync(scheduledConfigPath(PID), 'utf8')) as Record<string, unknown>;
    expect(doc.todos).toEqual(['t1']);
    expect(doc.notes).toBe('old'); // the stale read would have reverted nothing
    expect((doc.scheduledTasks as unknown[]).length).toBe(1);
  });
});

describe('fix D: the loop-file toggle preserves the file line endings', () => {
  it('rewrites the flag without converting CRLF to LF (replace and append)', () => {
    const crlf = ['---', 'name: x', 'enabled: false', 'schedule: 0 8 * * *', '---', 'Body'].join('\r\n');
    const out = writeLoopEnabled(crlf, true);
    expect(out).toBe(['---', 'name: x', 'enabled: true', 'schedule: 0 8 * * *', '---', 'Body'].join('\r\n'));
    expect(writeLoopEnabled(['---', 'name: y', '---', 'B'].join('\n'), true))
      .toBe(['---', 'name: y', 'enabled: true', '---', 'B'].join('\n'));
    const crlfAppend = ['---', 'name: z', 'enabled:', 'schedule: 0 8 * * *', '---', 'B'].join('\r\n');
    expect(writeLoopEnabled(crlfAppend, false))
      .toBe(['---', 'name: z', 'enabled: false', 'schedule: 0 8 * * *', '---', 'B'].join('\r\n')); // no-value + CRLF
    expect(writeLoopEnabled(['---', 'name: w', '---', 'B'].join('\r\n'), true))
      .toBe(['---', 'name: w', 'enabled: true', '---', 'B'].join('\r\n')); // appended inside the fence
  });
});

describe('route input abuse (pins)', () => {
  it('oversized, binary, and over-cap prompt bodies all answer one 400', async () => {
    const PID = 'abuse-pin';
    seedConfig(PID, { scheduledTasks: [taskDoc()] });
    const api = call(buildApp());
    expect((await api('/api/projects/abuse-pin/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({ task: taskDoc({ execution: { prompt: 'x'.repeat(25_000), providerID: 'a', modelID: 'b' } }) }),
    })).status).toBe(400);
    const big = await api('/api/projects/abuse-pin/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({ task: taskDoc(), padding: 'y'.repeat(300 * 1024) }),
    });
    expect(big.status).toBe(400);
    expect((await api('/api/projects/abuse-pin/scheduled-tasks', {
      method: 'PUT', body: '[' + String.fromCharCode(0) + ' not json',
    })).status).toBe(400);
    expect((await loadScheduledTasks(PID, OPT)).tasks).toHaveLength(1); // nothing corrupting the store
  });

  it('weird projectIds and taskIds answer the registered codes', async () => {
    const PID = 'weird-pin';
    seedConfig(PID, { scheduledTasks: [taskDoc()] });
    const api = call(buildApp());
    expect((await api('/api/projects/a.b/scheduled-tasks')).status).toBe(400);
    expect((await api('/api/projects/weird-pin/scheduled-tasks/a%2Fb', { method: 'DELETE' })).status).toBe(404);
    expect((await api('/api/projects/ghost/scheduled-tasks/task-1/run', { method: 'POST' })).status).toBe(404);
  });

  it('run-now still runs a once-consumed (paused) task (C.6 line 892)', async () => {
    const PID = 'paused-pin';
    seedConfig(PID, { scheduledTasks: [{
      ...taskDoc({ id: 'once-1', enabled: false }),
      schedule: { kind: 'once', date: '2026-09-26', time: '08:00', timezone: 'UTC' },
    }] });
    const api = call(buildApp());
    const run = await api('/api/projects/paused-pin/scheduled-tasks/once-1/run', { method: 'POST' });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ ok: true, status: 'success', sessionID: 'sess-audit' });
  });

  it('parseLoopFile handles CRLF fences and bodies', () => {
    const text = ['---', 'name: crlfed', 'schedule: 0 8 * * *', 'model: a/b', '---', '', 'Body line', ''].join('\r\n');
    const parsed = parseLoopFile(text, OPT);
    expect(parsed.definition?.name).toBe('crlfed');
    expect(parsed.definition?.execution.prompt).toBe('Body line');
  });
});

describe('investigated, verified correct (pins)', () => {
  it('a definition-null file never rewrites the doc (byte pin)', async () => {
    const PID = 'broken-pin';
    const dir = joinPath(ROOT, 'broken2');
    const file = writeLoopFile(dir, 'bug', 'bug');
    seedConfig(PID, { notes: 'n', scheduledTasks: [loopTaskDoc(file)] });
    writeLoopFile(dir, 'bug', 'bug', { schedule: 'junk' }); // same file, now unparseable
    const found = await discoverLoops(dir, OPT, USER_LOOPS);
    expect(found[0]?.definition).toBeNull();
    const bytes = readFileSync(scheduledConfigPath(PID), 'utf8');
    await reconcileLoopTasks(PID, found, OPT);
    expect(readFileSync(scheduledConfigPath(PID), 'utf8')).toBe(bytes); // kept, no write
  });

  it('reconcile with an empty discovery on a missing store never creates it', async () => {
    const PID = 'fresh-pin';
    expect(existsSync(scheduledConfigPath(PID))).toBe(false);
    await reconcileLoopTasks(PID, [], OPT);
    expect(existsSync(scheduledConfigPath(PID))).toBe(false);
  });

  it('a non-array scheduledTasks key is replaced with tasks, version booted, notes kept', async () => {
    const PID = 'shape-pin';
    seedConfig(PID, { notes: 'n', scheduledTasks: 'oops' });
    const file = writeLoopFile(joinPath(ROOT, 'shape'), 'made', 'made');
    await reconcileLoopTasks(PID, [discovered(file, 'made')], OPT);
    const tasks = await loadScheduledTasks(PID, OPT);
    expect(tasks.tasks.map((t) => t.id)).toEqual(['loop:project:made']);
    const doc = JSON.parse(readFileSync(scheduledConfigPath(PID), 'utf8')) as Record<string, unknown>;
    expect(doc.notes).toBe('n');
    expect(doc.version).toBe(1);
  });

  it('a malformed store doc is renamed aside and rewritten like upsert does', async () => {
    const PID = 'mal-pin';
    mkdirSync(joinPath(ROOT, 'projects'), { recursive: true });
    writeFileSync(scheduledConfigPath(PID), 'not json at all');
    const file = writeLoopFile(joinPath(ROOT, 'mal'), 'halting', 'halting');
    await reconcileLoopTasks(PID, [discovered(file, 'halting')], OPT);
    expect(readdirSync(joinPath(ROOT, 'projects')).some((n) => n.startsWith('mal-pin.json.corrupt-'))).toBe(true);
    const tasks = await loadScheduledTasks(PID, OPT);
    expect(tasks.tasks.map((t) => t.id)).toEqual(['loop:project:halting']);
  });

  it('DELETE loop-file twice answers 200 then 404 (pruned)', async () => {
    const PID = 'twice-pin';
    mkdirSync(joinPath(projectDir, 'twice'), { recursive: true });
    const file = writeLoopFile(joinPath(projectDir, 'twice'), 'once', 'once');
    dirs.set(PID, joinPath(projectDir, 'twice'));
    seedConfig(PID, { scheduledTasks: [loopTaskDoc(file)] });
    const api = call(buildApp());
    const first = await api(`/api/projects/${PID}/scheduled-tasks/loop:project:daily/loop-file`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    const second = await api(`/api/projects/${PID}/scheduled-tasks/loop:project:daily/loop-file`, { method: 'DELETE' });
    expect(second.status).toBe(404);
  });

  it('run-now/status with a never-started runtime: 500 run, empty status shape', async () => {
    const PID = 'nullrt-pin';
    seedConfig(PID, { scheduledTasks: [taskDoc()] });
    const api = call(new Hono().route('/', createScheduledTaskRoutes(() => null)));
    const status = await api('/api/openchamber/scheduled-tasks/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ running: { global: 0, byProject: {} }, queued: 0, tasks: [] });
    expect((await api(`/api/projects/${PID}/scheduled-tasks/task-1/run`, { method: 'POST' })).status).toBe(500);
  });

  it('PATCH loop-file on a task whose file vanished mid-flight answers 404 not a write', async () => {
    const PID = 'vanish-pin';
    seedConfig(PID, { scheduledTasks: [loopTaskDoc(joinPath(ROOT, 'vanished.md'))] });
    const api = call(buildApp());
    const patch = await api(`/api/projects/${PID}/scheduled-tasks/loop:project:daily/loop-file`, {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(404);
    expect(((await patch.json()) as { error: string }).error).toMatch(/loop file is gone/iu);
  });

  it('a directory named *.md in the loop dir is excluded, not fatal', async () => {
    const dir = joinPath(ROOT, 'wildname');
    const file = writeLoopFile(dir, 'ok', 'ok');
    mkdirSync(joinPath(dir, 'fake.md'), { recursive: true });
    const found = await discoverLoops(dir, OPT, dir);
    expect(found.map((l) => l.file)).toEqual([file]);
    // a loop dir that is itself a FILE contributes nothing (read errno degrades)
    expect(await discoverLoops(null, OPT, file)).toEqual([]);
  });
});
