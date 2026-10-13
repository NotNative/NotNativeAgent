// SPDX-License-Identifier: Apache-2.0
/** P9-3d scheduled-task routes (doc 03 §5.16) over a real store + runtime:
 * the list/upsert/delete family with project 400/404 semantics, the loop
 * ownership gates, the loop-file PATCH/DELETE file mutations riding the
 * C.8 reconcile through the runtime sync, run-now 200/400/409, the status
 * snapshot, and the per-project config PUT that must NOT clobber the
 * managed `scheduledTasks` key. */
import { describe, expect, it, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { Hono } from 'hono';
import type { ScheduledRouteOptions } from '../routes/scheduled-tasks.ts';
import type { RuntimePorts, PipelineOutcome } from '../scheduled/scheduled-runtime.ts';
import type { DiscoveredLoop } from '../scheduled/loops.ts';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p93d-routes-`);
process.env.NOTNATIVE_DATA_DIR = ROOT;

const { createScheduledTaskRoutes } = await import('../routes/scheduled-tasks.ts');
const { registerProjectsRoutes } = await import('../routes/projects.ts');
const { createScheduledTasksRuntime } = await import('../scheduled/scheduled-runtime.ts');
const { createScheduledStorePorts, scheduledNormalizeOptions } = await import('../scheduled/scheduled-service.ts');
const { reconcileLoopTasks, scheduledConfigPath } = await import('../scheduled/task-config.ts');
const { discoverLoops } = await import('../scheduled/loops.ts');

const NOW = Date.UTC(2026, 8, 26, 9, 0, 0); // Sat 2026-09-26 09:00Z
const OPT = scheduledNormalizeOptions();
const USER_LOOPS = joinPath(ROOT, 'user-loops'); // absent in tests: user scope empty
const projectDir = joinPath(ROOT, 'worktree');

const dirs = new Map<string, string>();
let runtime: ReturnType<typeof createScheduledTasksRuntime> | null = null;
let pipelineBehavior: 'ok' | 'refuse' = 'ok';

function makeRuntime(limits: { maxProjectConcurrency?: number } = {}): ReturnType<typeof createScheduledTasksRuntime> {
  const ports: RuntimePorts = {
    ...createScheduledStorePorts(),
    listProjects: async () => readdirSync(joinPath(ROOT, 'projects'))
      .filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -5)),
    runPipeline: async (): Promise<PipelineOutcome> => {
      if (pipelineBehavior === 'refuse') throw new Error('pipeline refused');
      return { sessionID: 'sess-run-1' };
    },
    emit: () => {},
    log: { warn: () => {}, error: () => {} },
    now: () => NOW,
    jitter: () => 0,
    normalizeOptions: OPT,
    loopsFor: (projectId) => dirs.get(projectId) !== undefined
      ? discoverLoops(dirs.get(projectId) as string, OPT, USER_LOOPS)
      : Promise.resolve(null),
    reconcileLoops: async (projectId, loops) => {
      await reconcileLoopTasks(projectId, [...loops], OPT);
    },
  };
  return createScheduledTasksRuntime(ports, limits);
}

function buildApp(limits: { maxProjectConcurrency?: number } = {}, opts: ScheduledRouteOptions = {}): Hono {
  runtime = makeRuntime(limits);
  const defaultLoops = async (projectId: string): Promise<readonly DiscoveredLoop[] | null> =>
    dirs.get(projectId) !== undefined
      ? discoverLoops(dirs.get(projectId) as string, OPT, USER_LOOPS)
      : null;
  return new Hono().route('/', createScheduledTaskRoutes(() => runtime, {
    loopsFor: opts.loopsFor ?? defaultLoops,
  }));
}

function seededApp(): Hono {
  const inner = new Hono();
  registerProjectsRoutes(inner);
  return inner;
}

const call = (a: Hono) => async (path: string, init?: RequestInit): Promise<Response> =>
  a.fetch(new Request(`http://t.test${path}`, { headers: { 'content-type': 'application/json' }, ...init })) as Promise<Response>;

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: NOW, updatedAt: NOW, lastStatus: 'idle' },
    ...patch,
  };
}

function seedConfig(projectId: string, doc: unknown): void {
  mkdirSync(joinPath(ROOT, 'projects'), { recursive: true });
  writeFileSync(scheduledConfigPath(projectId), JSON.stringify(doc, null, 2));
}

const readConfig = (projectId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(scheduledConfigPath(projectId), 'utf8')) as Record<string, unknown>;

function writeLoopFile(project: string, stem: string, name: string, meta: Record<string, string> = {}): string {
  const dir = joinPath(project, '.agents', 'loops');
  mkdirSync(dir, { recursive: true });
  const file = joinPath(dir, `${stem}.md`);
  writeFileSync(file, ['---', `name: ${name}`, 'schedule: 0 8 * * *', 'enabled: false',
    ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`), 'model: a/b', '---', 'Loop body', ''].join('\n'));
  return file;
}

afterEach(() => { runtime?.stop(); dirs.clear(); pipelineBehavior = 'ok'; });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('GET list family (§5.16)', () => {
  it('answers the normalized tasks; malformed id 400; unknown project 404', async () => {
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc()] });
    const ok = await api('/api/projects/alpha/scheduled-tasks');
    expect(ok.status).toBe(200);
    const body = await ok.json() as { tasks: Array<{ id: string; name: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ id: 'task-1', name: 'Nightly digest', enabled: true });
    expect((await api('/api/projects/no%2Fgood/scheduled-tasks')).status).toBe(400);
    expect((await api('/api/projects/ghost/scheduled-tasks')).status).toBe(404);
  });
});

describe('PUT upsert + loop gates', () => {
  it('upserts, syncs, and answers the task; rejects malformed bodies', async () => {
    const api = call(buildApp());
    seedConfig('alpha', { notes: 'keepme', scheduledTasks: [] });
    const ok = await api('/api/projects/alpha/scheduled-tasks', { method: 'PUT', body: JSON.stringify({ task: taskDoc() }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 'task-1', enabled: true });
    const doc = readConfig('alpha');
    expect(doc.notes).toBe('keepme');
    expect((doc.scheduledTasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['task-1']);
    expect((await api('/api/projects/alpha/scheduled-tasks', { method: 'PUT', body: '{"task":4}' })).status).toBe(400);
    const bad = await api('/api/projects/alpha/scheduled-tasks', { method: 'PUT', body: JSON.stringify({ task: { id: 'task-2' } }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/name/iu);
    expect((await api('/api/projects/ghost/scheduled-tasks', { method: 'PUT', body: '{}' })).status).toBe(404);
  });

  it('refuses loop-owned identities while the file exists or a loop owns the name', async () => {
    mkdirSync(joinPath(projectDir, 'projects', 'alpha'), { recursive: true });
    const file = writeLoopFile(projectDir, 'taken', 'taken');
    dirs.set('alpha', projectDir);
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc({ id: 'loop:project:taken', loopFile: file })] });
    const byId = await api('/api/projects/alpha/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({ task: taskDoc({ id: 'loop:project:taken', name: 'taken', loopFile: file }) }),
    });
    expect(byId.status).toBe(400);
    const byName = await api('/api/projects/alpha/scheduled-tasks', {
      method: 'PUT', body: JSON.stringify({ task: taskDoc({ id: 'fresh', name: 'taken' }) }),
    });
    expect(byName.status).toBe(400);
    expect(((await byName.json()) as { error: string }).error).toMatch(/loop file/iu);
  });
});

describe('DELETE task + ownership rules', () => {
  it('removes plain tasks, guards live loop files, frees orphans, 404s unknowns', async () => {
    const api = call(buildApp());
    const orphanFile = joinPath(ROOT, 'never-created.md');
    seedConfig('alpha', { scheduledTasks: [taskDoc(), taskDoc({ id: 'orphan', loopFile: orphanFile })] });
    seedConfig('beta', {
      scheduledTasks: [taskDoc({ id: 'live-loop', loopFile: joinPath(ROOT, 'live.md') })],
    });
    writeFileSync(joinPath(ROOT, 'live.md'), '---\nname: live\nschedule: 0 8 * * *\nmodel: a/b\n---\nBody\n');
    expect((await api('/api/projects/ghost/scheduled-tasks/task-1', { method: 'DELETE' })).status).toBe(404);
    const guarded = await api('/api/projects/beta/scheduled-tasks/live-loop', { method: 'DELETE' });
    expect(guarded.status).toBe(400);
    expect(((await guarded.json()) as { error: string }).error).toMatch(/delete the loop file/iu);
    const orphan = await api('/api/projects/alpha/scheduled-tasks/orphan', { method: 'DELETE' });
    expect(orphan.status).toBe(200);
    expect(((await orphan.json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toEqual(['task-1']);
    const plain = await api('/api/projects/alpha/scheduled-tasks/task-1', { method: 'DELETE' });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect((await api('/api/projects/alpha/scheduled-tasks/task-1', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('loop-file PATCH/DELETE ride the C.8 reconcile', () => {
  it('PATCH writes the enabled flag and the file wins after the sync', async () => {
    mkdirSync(joinPath(projectDir, 'projects', 'alpha'), { recursive: true });
    const file = writeLoopFile(projectDir, 'flagged', 'flagged');
    dirs.set('alpha', projectDir);
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc({
      id: 'loop:project:flagged', name: 'flagged', enabled: false, loopFile: file,
    }), taskDoc({ id: 'plainer', name: 'Plainer' })] });
    const patch = await api('/api/projects/alpha/scheduled-tasks/loop:project:flagged/loop-file', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { task: { enabled: boolean } }).task.enabled).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('enabled: true');
    expect((await stored('alpha', api)).find((t) => t.id === 'loop:project:flagged')?.enabled).toBe(true);
    const toggled = await api('/api/projects/alpha/scheduled-tasks/loop:project:flagged/loop-file', {
      method: 'PATCH', body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(toggled.status).toBe(400);
    const unknownTask = await api('/api/projects/alpha/scheduled-tasks/task-x/loop-file', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(unknownTask.status).toBe(404);
    const notLoop = await api('/api/projects/alpha/scheduled-tasks/plainer/loop-file', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(notLoop.status).toBe(400);
    expect(((await notLoop.json()) as { error: string }).error).toMatch(/not loop-sourced/iu);
  });

  it('DELETE removes the file and the reconcile prunes the task', async () => {
    const file = writeLoopFile(projectDir, 'dying', 'dying');
    dirs.set('alpha', projectDir);
    const api = call(buildApp());
    seedConfig('alpha', { notes: 'stay', scheduledTasks: [taskDoc({
      id: 'loop:project:dying', name: 'dying', enabled: false, loopFile: file,
    })] });
    const removed = await api('/api/projects/alpha/scheduled-tasks/loop:project:dying/loop-file', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    const tasks = (await removed.json() as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks.filter((t) => t.id === 'loop:project:dying')).toHaveLength(0);
    expect(readConfig('alpha').notes).toBe('stay');
    const plain = await api('/api/projects/alpha/scheduled-tasks/plain/loop-file', { method: 'DELETE' });
    expect(plain.status).toBe(404);
  });
});

async function stored(projectId: string, api: (p: string, init?: RequestInit) => Promise<Response>):
Promise<Array<{ id: string; enabled: boolean }>> {
  const response = await api(`/api/projects/${projectId}/scheduled-tasks`);
  return (await response.json() as { tasks: Array<{ id: string; enabled: boolean }> }).tasks;
}

describe('POST run + 400/409 mapping (C.6 line 892)', () => {
  it('runs now, answers the outcome, and refuses unknown/busy/capacity', async () => {
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc()] });
    const ok = await api('/api/projects/alpha/scheduled-tasks/task-1/run', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, status: 'success', sessionID: 'sess-run-1' });
    expect((await api('/api/projects/alpha/scheduled-tasks/missing-task/run', { method: 'POST' })).status).toBe(400);
    runtime?.internals.running.add('alpha:task-1');
    const busy = await api('/api/projects/alpha/scheduled-tasks/task-1/run', { method: 'POST' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/running or queued/iu);
  });

  it('exhausted capacity maps to 409 over a fresh zero-slot runtime', async () => {
    const api = call(buildApp({ maxProjectConcurrency: 0 }));
    seedConfig('alpha', { scheduledTasks: [taskDoc()] });
    const capped = await api('/api/projects/alpha/scheduled-tasks/task-1/run', { method: 'POST' });
    expect(capped.status).toBe(409);
    expect(((await capped.json()) as { error: string }).error).toMatch(/capacity/iu);
  });

  it('a dispatching pipeline failure is a 200 run with error status', async () => {
    pipelineBehavior = 'refuse';
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc()] });
    const failed = await api('/api/projects/alpha/scheduled-tasks/task-1/run', { method: 'POST' });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ok: false, status: 'error' });
  });
});

describe('GET scheduler status', () => {
  it('reports running state and the soonest-first task list', async () => {
    const api = call(buildApp());
    seedConfig('alpha', { scheduledTasks: [taskDoc({ id: 'later', schedule: { kind: 'cron', cron: '30 22 * * *', timezone: 'UTC' } })] });
    seedConfig('beta', { scheduledTasks: [taskDoc({ id: 'sooner', schedule: { kind: 'cron', cron: '15 9 * * *', timezone: 'UTC' } })] });
    await runtime?.syncProject('alpha');
    await runtime?.syncProject('beta');
    const status = await api('/api/openchamber/scheduled-tasks/status');
    expect(status.status).toBe(200);
    const body = await status.json() as {
      running: { global: number; byProject: Record<string, number> };
      queued: number;
      tasks: Array<{ projectId: string; id: string; nextRunAt?: number }>;
    };
    expect(body.running.global).toBe(0);
    expect(body.queued).toBe(0);
    expect(body.tasks[0]?.projectId).toBe('beta');
    expect(body.tasks[0]?.id).toBe('sooner');
    expect(body.tasks.every((t) => typeof t.nextRunAt === 'number' && t.nextRunAt > NOW)).toBe(true);
  });
});

describe('per-project config PUT does NOT clobber scheduledTasks', () => {
  it('replaces UI keys while preserving scheduled tasks and unseeded legacy context', async () => {
    const api = call(seededApp());
    seedConfig('alpha', { version: 1, notes: 'old', scheduledTasks: [taskDoc()] });
    const put = await api('/api/projects/alpha/config', {
      method: 'PUT', body: JSON.stringify({ actions: ['a1'], scheduledTasks: ['evil'] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ actions: ['a1'] });
    const doc = readConfig('alpha');
    expect(doc.actions).toEqual(['a1']);
    expect(doc.notes).toBe('old'); // retained until the context file is durably seeded
    expect(doc.scheduledTasks).toEqual([taskDoc()]);
    const fresh = await api('/api/projects/ghost/config', {
      method: 'PUT', body: JSON.stringify({ actions: [] }),
    });
    expect(fresh.status).toBe(200);
    expect(readConfig('ghost')).toEqual({ actions: [] });
  });
});
