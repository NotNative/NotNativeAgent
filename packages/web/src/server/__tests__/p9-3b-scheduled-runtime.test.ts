// SPDX-License-Identifier: Apache-2.0
/** P9-3b scheduled-task runtime: timers, queue, claiming, completion. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStatePatch } from '../scheduled/task-config.ts';
import { normalizeTaskForStorage, type ScheduledTask } from '../scheduled/task-schema.ts';
import { createScheduledTasksRuntime } from '../scheduled/scheduled-runtime.ts';
import type { RunOutcome, RuntimePorts } from '../scheduled/scheduled-runtime.ts';

const t0 = Date.UTC(2026, 8, 21, 9, 0, 0); // Mon 2026-09-21 09:00Z
const DUE = Date.UTC(2026, 8, 22, 9); // Tue 2026-09-22 09:00Z (cron 0 9 * * *)
const NEXT = Date.UTC(2026, 8, 23, 9);

interface StoreState {
  projects: Map<string, Map<string, Record<string, unknown>>>;
  patches: Array<{ projectId: string; taskId: string; patch: Record<string, unknown> }>;
  patchFailures: number;
  patchIfFailures: number;
  pipelineCalls: Array<{ projectId: string; taskId: string; reason: string }>;
  events: Array<{ status: string; taskId: string; sessionID?: string }>;
  logs: string[];
  pipelineDelay: number;
  pipelineSession: string;
}

function taskDoc(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1', name: 'Nightly digest', enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Summarize', providerID: 'nna', modelID: 'workspace-default' },
    state: { createdAt: t0, updatedAt: t0, lastStatus: 'idle' },
    ...patch,
  };
}

function makeStore(): StoreState {
  return {
    projects: new Map(), patches: [], patchFailures: 0, patchIfFailures: 0,
    pipelineCalls: [], events: [], logs: [], pipelineDelay: 0,
    pipelineSession: 'ses_scheduled',
  };
}

function seed(store: StoreState, projectId: string, doc: Record<string, unknown>): void {
  const map = store.projects.get(projectId) ?? new Map<string, Record<string, unknown>>();
  map.set(String(doc.id), doc);
  store.projects.set(projectId, map);
}

function normalizeFor(raw: Record<string, unknown> | null): ScheduledTask | null {
  if (raw === null) return null;
  const outcome = normalizeTaskForStorage(raw, { now: t0, serverZone: 'UTC' });
  return outcome.ok ? outcome.task : null;
}

type PortOverrides = Partial<RuntimePorts>;

function makePorts(store: StoreState, overrides: PortOverrides = {}): RuntimePorts {
  const ports: Omit<RuntimePorts, 'store'> = {
    load: async (projectId) => {
      const map = store.projects.get(projectId);
      if (!map) throw new Error(`project ${projectId} unreadable`);
      const tasks: ScheduledTask[] = [];
      for (const raw of map.values()) {
        const known = normalizeFor(raw);
        if (known !== null) tasks.push(known);
      }
      return { tasks, invalid: [] };
    },
    patch: async (projectId, taskId, patch) => {
      if (store.patchFailures > 0) { store.patchFailures -= 1; throw new Error('disk full'); }
      const raw = store.projects.get(projectId)?.get(taskId);
      if (!raw) throw new Error('task vanished');
      store.projects.get(projectId)?.set(taskId, applyStatePatch(raw, patch));
      store.patches.push({ projectId, taskId, patch });
      return true;
    },
    patchIf: async (projectId, taskId, predicate, patch) => {
      if (store.patchIfFailures > 0) { store.patchIfFailures -= 1; throw new Error('lock storm'); }
      const raw = store.projects.get(projectId)?.get(taskId);
      if (!raw) return { updated: false, task: null };
      if (!predicate(raw)) return { updated: false, task: raw };
      const updated = applyStatePatch(raw, patch);
      store.projects.get(projectId)?.set(taskId, updated);
      store.patches.push({ projectId, taskId, patch });
      return { updated: true, task: updated };
    },
    consumeOnce: async (projectId, task) => {
      const raw = store.projects.get(projectId)?.get(task.id);
      if (raw) store.projects.get(projectId)?.set(task.id, { ...raw, enabled: false });
    },
    readLatest: async (projectId, taskId) => normalizeFor(store.projects.get(projectId)?.get(taskId) ?? null),
    runPipeline: (request) => {
      store.pipelineCalls.push({ projectId: request.projectId, taskId: request.taskId, reason: request.reason });
      if (store.pipelineDelay > 0) {
        return new Promise((resolve) => { setTimeout(() => { resolve({ sessionID: store.pipelineSession }); }, store.pipelineDelay); });
      }
      return Promise.resolve({ sessionID: store.pipelineSession });
    },
    emit: (event) => { store.events.push({ status: event.status, taskId: event.taskId, sessionID: event.sessionID }); },
    log: {
      warn: (message) => { store.logs.push(`warn:${message}`); },
      error: (message) => { store.logs.push(`error:${message}`); },
    },
    now: () => Date.now(),
    jitter: () => 0,
    normalizeOptions: { now: t0, serverZone: 'UTC' },
    listProjects: () => Promise.resolve([...store.projects.keys()]),
    ...overrides,
  };
  return { ...ports };
}

function makeRuntime(
  store: StoreState,
  limits: { maxGlobalConcurrency?: number; maxProjectConcurrency?: number; maxRunDurationMs?: number } = {},
  overrides: PortOverrides = {},
) {
  return createScheduledTasksRuntime(makePorts(store, overrides), limits);
}

function rememberOne(runtime: ReturnType<typeof createScheduledTasksRuntime>, projectId: string, doc: Record<string, unknown>): void {
  const known = normalizeFor(doc) as ScheduledTask;
  runtime.internals.tasksByProject.set(projectId, new Map([[known.id, known]]));
}

beforeEach(() => { vi.useFakeTimers({ now: t0 }); });
afterEach(() => { vi.useRealTimers(); });

async function settle(ms: number, store?: StoreState): Promise<void> {
  void store;
  await vi.advanceTimersByTimeAsync(ms);
}

describe('arming and due fire (C.4)', () => {
  it('fires a due cron task through claim, pipeline, completion, re-arm', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    expect(store.patches.some((entry) => entry.patch.nextRunAt === DUE)).toBe(true);
    expect([...runtime.internals.timers.keys()]).toEqual(['proj:task-1']);
    await settle(DUE + 1 - t0, store);
    expect(store.pipelineCalls).toEqual([{ projectId: 'proj', taskId: 'task-1', reason: 'scheduled' }]);
    const completion = store.patches.find((entry) => entry.patch.lastStatus === 'success');
    expect(completion?.patch.lastSessionId).toBe('ses_scheduled');
    expect(store.events.at(-1)).toMatchObject({ status: 'success', sessionID: 'ses_scheduled' });
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
  });

  it('does not arm disabled tasks or consumed slots', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ enabled: false }));
    seed(store, 'proj', taskDoc({ id: 'task-2', schedule: { kind: 'once', date: '2026-09-01', time: '09:00', timezone: 'UTC' } }));
    const runtime = makeRuntime(store);
    await runtime.start();
    expect(runtime.internals.timers.size).toBe(0);
    expect(store.pipelineCalls).toHaveLength(0);
  });

  it('re-arms beyond the setTimeout cap without firing early', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ schedule: { kind: 'once', date: '2027-09-21', time: '09:00', timezone: 'UTC' } }));
    const runtime = makeRuntime(store);
    await runtime.start();
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(Date.UTC(2027, 8, 21, 9));
    expect(runtime.internals.queue).toHaveLength(0);
    await settle(2_147_483_647, store);
    expect(runtime.internals.timers.has('proj:task-1')).toBe(true);
    expect(store.pipelineCalls).toHaveLength(0);
  });

  it('does not re-enqueue a task already running', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    store.pipelineDelay = 30_000;
    const runtime = makeRuntime(store);
    await runtime.start();
    await settle(DUE + 1 - t0, store);
    expect(runtime.enqueue({ projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE })).toBe(false);
    expect(store.pipelineCalls).toHaveLength(1);
  });

  it('holds overflow work at the caps and drains after completion', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ id: 'a', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' } }));
    seed(store, 'proj', taskDoc({ id: 'b', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' } }));
    seed(store, 'proj', taskDoc({ id: 'c', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' } }));
    store.pipelineDelay = 10_000;
    const runtime = makeRuntime(store, { maxProjectConcurrency: 1, maxGlobalConcurrency: 1 });
    await runtime.start();
    await settle(DUE + 1 - t0, store);
    expect(store.pipelineCalls).toHaveLength(1);
    expect(runtime.internals.counts().global).toBe(1);
    await settle(60_000, store);
    expect(store.pipelineCalls).toHaveLength(3);
  });
});

describe('occurrence claiming (C.5)', () => {
  it('a sibling claim rejects ours: no dispatch, re-arm from their slot', async () => {
    const store = makeStore();
    const theirSlot = DUE - 1;
    const doc = taskDoc({ state: { createdAt: t0, updatedAt: t0, lastStatus: 'running', lastScheduledFor: theirSlot, nextRunAt: NEXT } });
    const runtime = makeRuntime(store);
    seed(store, 'proj', doc);
    rememberOne(runtime, 'proj', doc);
    const outcome = await runtime.internals.runTask({ projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE });
    expect(outcome).toMatchObject({ ok: false, skipped: true, reason: 'occurrence-claimed' });
    expect(store.pipelineCalls).toHaveLength(0);
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
    expect(runtime.internals.counts().global).toBe(0);
  });

  it('a claim store failure records the error and re-arms the next slot', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    store.patchIfFailures = 1;
    vi.setSystemTime(DUE + 1);
    const outcome = await runtime.internals.runTask({ projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE });
    expect(outcome).toMatchObject({ ok: false, skipped: true, reason: 'claim-failed' });
    expect(store.pipelineCalls).toHaveLength(0);
    const failure = [...store.patches].reverse().find((entry) => entry.patch.lastStatus === 'error');
    expect(failure?.patch.lastStatus).toBe('error');
    expect(String(failure?.patch.lastError)).toContain('Scheduled claim failed');
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
  });

  it('skips scheduled dispatch without a finite scheduledFor', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    await runtime.enqueue({ projectId: 'proj', taskId: 'task-1', reason: 'scheduled' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.pipelineCalls).toHaveLength(0);
    expect(runtime.internals.counts().global).toBe(0);
  });
});

describe('watchdog and completion (C.6/C.7)', () => {
  it('times out a hung run, records the error, and frees the slot', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    store.pipelineDelay = 5_000;
    const runtime = makeRuntime(store, { maxRunDurationMs: 50 });
    await runtime.start();
    vi.setSystemTime(DUE + 1);
    const settled = runtime.runNow('proj', 'task-1');
    await settle(100, store);
    const outcome = await settled;
    expect(outcome).toMatchObject({ ok: false, status: 'error' });
    const completion = store.patches.find((entry) => entry.patch.lastStatus === 'error');
    expect(String(completion?.patch.lastError)).toContain('timed out');
    expect(outcome.sessionID).toBeUndefined();
    expect(store.events.at(-1)?.status).toBe('error');
    expect(runtime.internals.counts().global).toBe(0);
  });

  it('consumes a one-time task on scheduled completion and does not re-arm', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ schedule: { kind: 'once', date: '2026-09-22', time: '09:00', timezone: 'UTC' } }));
    const runtime = makeRuntime(store);
    await runtime.start();
    await settle(DUE + 1 - t0, store);
    expect(store.projects.get('proj')?.get('task-1')?.enabled).toBe(false);
    expect(runtime.internals.timers.size).toBe(0);
    const completion = store.patches.find((entry) => 'lastSessionId' in entry.patch);
    expect(completion?.patch.nextRunAt).toBeUndefined();
  });

  it('completion persist failure retried once, then terminal + re-arm', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    store.patchFailures = 2;
    await settle(DUE + 1 - t0, store);
    expect(store.pipelineCalls).toHaveLength(1);
    expect(runtime.internals.counts().global).toBe(0);
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
    const memory = runtime.internals.tasksByProject.get('proj')?.get('task-1');
    expect(memory?.state.lastStatus).toBe('success');
    expect(memory?.state.lastSessionId).toBe('ses_scheduled');
    expect(store.projects.get('proj')?.get('task-1')?.state).toMatchObject({ lastStatus: 'running', lastScheduledFor: DUE });
  });
});

describe('manual runs (C.5)', () => {
  it('runs a paused task, never claims, and never re-arms it', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ enabled: false }));
    const runtime = makeRuntime(store);
    await runtime.start();
    const outcome = await runtime.runNow('proj', 'task-1');
    expect(outcome).toMatchObject({ ok: true, status: 'success', sessionID: 'ses_scheduled' });
    expect(store.pipelineCalls.map((call) => call.reason)).toEqual(['manual']);
    expect(store.patches.some((entry) => 'lastScheduledFor' in entry.patch)).toBe(false);
    expect(runtime.internals.timers.size).toBe(0);
  });

  it('a manual once run is not consumed', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({ schedule: { kind: 'once', date: '2027-01-01', time: '09:00', timezone: 'UTC' } }));
    const runtime = makeRuntime(store);
    await runtime.start();
    await runtime.runNow('proj', 'task-1');
    expect(store.projects.get('proj')?.get('task-1')?.enabled).toBe(true);
  });

  it('refuses a manual run while the task is busy', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    store.pipelineDelay = 5_000;
    const runtime = makeRuntime(store);
    await runtime.start();
    const first = runtime.runNow('proj', 'task-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(await runtime.runNow('proj', 'task-1')).toEqual({ ok: false, reason: 'task-busy' });
    await settle(6_000, store);
    expect(await first).toMatchObject({ ok: true, status: 'success' });
  });
});

describe('sync and lifecycle', () => {
  it('start() syncs listed projects and drops vanished project timers', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store, {}, { listProjects: () => Promise.resolve(['proj']) });
    rememberOne(runtime, 'gone-old-project', taskDoc({ id: 'old' }));
    runtime.internals.scheduleFutureRun('gone-old-project', normalizeFor(taskDoc({ id: 'old' })) as ScheduledTask, t0 + 60_000);
    await runtime.start();
    expect(runtime.internals.timers.has('gone-old-project:old')).toBe(false);
    expect(runtime.internals.timers.has('proj:task-1')).toBe(true);
  });

  it('a broken project is skipped; siblings still schedule', async () => {
    const store = makeStore();
    seed(store, 'good', taskDoc({ id: 'ok' }));
    const runtime = makeRuntime(store, {}, { listProjects: () => Promise.resolve(['broken', 'good']) });
    await runtime.start();
    expect(store.logs.some((line) => line.includes('broken skipped'))).toBe(true);
    expect(runtime.internals.timers.has('good:ok')).toBe(true);
  });

  it('listProjects failure aborts the sync without dispatching', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store, {}, { listProjects: () => Promise.reject(new Error('no list')) });
    const started = await runtime.start();
    expect(started).toBe(false);
    expect(store.pipelineCalls).toHaveLength(0);
  });

  it('stop() clears timers and queued work', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    runtime.stop();
    expect(runtime.internals.timers.size).toBe(0);
    const outcome = await runtime.runNow('proj', 'task-1');
    expect(outcome.status).toBe('success');
  });
});

describe('adversarial regressions: post-claim failures, inert stop, refusal adoption', () => {
  it('a synchronous pipeline throw on a claimed run is a run error, not a claim failure', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store, {}, {
      runPipeline: (request) => {
        store.pipelineCalls.push({ projectId: request.projectId, taskId: request.taskId, reason: request.reason });
        throw new Error('pipeline boom'); // throws synchronously, never a promise
      },
    });
    await runtime.start();
    vi.setSystemTime(DUE + 1);
    const outcome = await runtime.internals.runTask({
      projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE,
    });
    // The claim already happened, so the run must exit through completion
    // with a real error record, never as a skipped claim failure.
    expect(outcome).toMatchObject({ ok: false, status: 'error' });
    expect(outcome.reason).toBeUndefined();
    expect(store.pipelineCalls).toHaveLength(1);
    expect(store.patches.some((entry) => String(entry.patch.lastError).includes('Scheduled claim failed'))).toBe(false);
    const completion = store.patches.find((entry) => entry.patch.lastStatus === 'error');
    expect(completion?.patch.lastError).toBe('pipeline boom');
    expect(store.events.at(-1)).toMatchObject({ status: 'error', taskId: 'task-1' });
    expect(runtime.internals.counts().global).toBe(0);
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
  });

  it('a manual run gets the same structured error when the pipeline throws synchronously', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store, {}, {
      runPipeline: (request) => {
        store.pipelineCalls.push({ projectId: request.projectId, taskId: request.taskId, reason: request.reason });
        throw new Error('pipeline boom'); // throws synchronously, never a promise
      },
    });
    await runtime.start();
    const outcome = await runtime.runNow('proj', 'task-1');
    expect(outcome).toMatchObject({ ok: false, status: 'error' });
    expect(store.pipelineCalls).toEqual([{ projectId: 'proj', taskId: 'task-1', reason: 'manual' }]);
    const completion = store.patches.find((entry) => entry.patch.lastStatus === 'error');
    expect(completion?.patch.lastError).toBe('pipeline boom');
    expect(store.events.at(-1)).toMatchObject({ status: 'error', taskId: 'task-1' });
    expect(runtime.internals.counts().global).toBe(0);
  });

  it('a throwing event emitter never fails the completed run', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store, {}, {
      emit: () => { throw new Error('sse write failed'); },
    });
    await runtime.start();
    vi.setSystemTime(DUE + 1);
    const outcome = await runtime.internals.runTask({
      projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE,
    });
    expect(outcome).toMatchObject({ ok: true, status: 'success', sessionID: 'ses_scheduled' });
    expect(outcome.reason).toBeUndefined();
    const completion = store.patches.find((entry) => entry.patch.lastStatus === 'success');
    expect(completion?.patch.lastSessionId).toBe('ses_scheduled');
    expect(store.logs.some((line) => line.includes('task run event refused'))).toBe(true);
    expect(store.logs.some((line) => line.includes('Scheduled claim failed'))).toBe(false);
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
  });

  it('stop() stays inert: a run that settles afterward persists but arms nothing', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc());
    const runtime = makeRuntime(store);
    await runtime.start();
    runtime.stop();
    expect(runtime.internals.timers.size).toBe(0);
    const outcome = await runtime.runNow('proj', 'task-1');
    expect(outcome).toMatchObject({ ok: true, status: 'success', sessionID: 'ses_scheduled' });
    expect(store.patches.some((entry) => entry.patch.lastStatus === 'success')).toBe(true);
    expect(runtime.internals.timers.size).toBe(0);
    expect(runtime.enqueue({ projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE })).toBe(false);
    expect(store.pipelineCalls).toHaveLength(1);
  });

  it('a refused claim adopts the winner task into memory and arms their slot', async () => {
    const store = makeStore();
    seed(store, 'proj', taskDoc({
      state: { createdAt: t0, updatedAt: t0, lastStatus: 'running', lastScheduledFor: DUE - 1, nextRunAt: NEXT },
    }));
    const runtime = makeRuntime(store);
    rememberOne(runtime, 'proj', taskDoc());
    const outcome = await runtime.internals.runTask({
      projectId: 'proj', taskId: 'task-1', reason: 'scheduled', scheduledFor: DUE,
    });
    expect(outcome).toMatchObject({ ok: false, skipped: true, reason: 'occurrence-claimed' });
    const memory = runtime.internals.tasksByProject.get('proj')?.get('task-1');
    expect(memory?.state.lastScheduledFor).toBe(DUE - 1);
    expect(memory?.state.lastStatus).toBe('running');
    expect(memory?.state.nextRunAt).toBe(NEXT);
    expect(runtime.internals.timers.get('proj:task-1')?.dueAt).toBe(NEXT);
    expect(store.pipelineCalls).toHaveLength(0);
  });
});
