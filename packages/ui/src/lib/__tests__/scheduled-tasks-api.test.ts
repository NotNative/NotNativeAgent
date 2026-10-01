// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task client pins (doc 03 §5.16 + doc 12 §C.10): every function
 * rides the exact app-origin route shape the server registered (URL, method,
 * body, response fold), failures fold into `{ok:false,status,error}`, and
 * the C.10 run-event parser only accepts a complete fanout payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../runtime-fetch.ts';
import {
  deleteLoopFile, deleteScheduledTask, listScheduledTasks, parseTaskRunEvent,
  previewNextRuns, runScheduledTask, schedulerStatus, setLoopFileEnabled,
  SCHEDULED_TASK_RAN, upsertScheduledTask, type ScheduledTaskInput, type ScheduledTaskView,
  type TaskSchedule,
} from '../scheduled-tasks-api.ts';
import type { HarnessEvent } from '../nnd/events.ts';

vi.mock('../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const call = runtimeFetch as ReturnType<typeof vi.fn>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function task(id: string, patch: Record<string, unknown> = {}): ScheduledTaskView {
  return {
    id, name: 'daily', enabled: true,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'water the plants', providerID: 'mock', modelID: 'm1' },
    state: { createdAt: 1, updatedAt: 2, lastStatus: 'idle' },
    ...patch,
  } as ScheduledTaskView;
}
const ranEvent = (payload: Record<string, unknown>): HarnessEvent => ({
  type: SCHEDULED_TASK_RAN, properties: payload,
});

beforeEach(() => { call.mockReset(); });

describe('scheduled-tasks-api routes (doc 03 §5.16)', () => {
  it('list rides GET on the project url and folds {tasks}', async () => {
    call.mockResolvedValueOnce(json(200, { tasks: [task('a'), task('b')] }));
    const outcome = await listScheduledTasks('alpha');
    expect(call).toHaveBeenCalledWith('/api/projects/alpha/scheduled-tasks', undefined);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.tasks.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('list folds the registered 400/404 errors with the server message', async () => {
    call.mockResolvedValueOnce(json(400, { error: 'unsupported characters in projectId' }));
    const bad = await listScheduledTasks('a/b');
    // The wire URL carries the literal %2F frame the server's Hono router
    // matches (param arrives decoded, then the projectId pattern answers 400).
    expect(call).toHaveBeenCalledWith('/api/projects/a%2Fb/scheduled-tasks', undefined);
    expect(bad).toEqual({ ok: false, status: 400, error: 'unsupported characters in projectId' });
    call.mockResolvedValueOnce(json(404, { error: 'unknown project' }));
    expect(await listScheduledTasks('ghost')).toEqual({ ok: false, status: 404, error: 'unknown project' });
  });

  it('upsert PUTs {task} and returns the normalized record', async () => {
    call.mockResolvedValueOnce(json(200, task('t1', { note: 'extra', state: { createdAt: 1, updatedAt: 9, lastStatus: 'idle' } })));
    const outcome = await upsertScheduledTask('alpha', task('t1', { note: 'extra' }));
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/alpha/scheduled-tasks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ task: { ...task('t1', { note: 'extra' }) } });
    expect(outcome.ok && outcome.task.id).toBe('t1');
    expect(outcome.ok && (outcome.task as Record<string, unknown>).note).toBe('extra');
  });

  it('a create payload may omit state; normalize() seeds it on the stored view', async () => {
    call.mockResolvedValueOnce(json(200, task('t9', { state: { createdAt: 5, updatedAt: 6, lastStatus: 'idle' } })));
    const create: ScheduledTaskInput = {
      id: 't9', name: 'once', enabled: true,
      schedule: { kind: 'once', date: '2026-09-26', time: '09:00', timezone: 'UTC' },
      execution: { prompt: 'water the plants', providerID: 'mock', modelID: 'm1' },
    };
    const outcome = await upsertScheduledTask('alpha', create);
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/alpha/scheduled-tasks');
    expect(init.method).toBe('PUT');
    // The wire body rides the server contract: no client-side state invention.
    expect(JSON.parse(String(init.body))).toEqual({ task: create });
    expect(outcome.ok && outcome.task.state.lastStatus).toBe('idle');
  });

  it('upsert folds the loop-ownership gate refusal verbatim', async () => {
    const message = 'a loop file defines this name: C:/repo/.agents/loops/daily.md';
    call.mockResolvedValueOnce(json(400, { error: message }));
    const outcome = await upsertScheduledTask('alpha', task('daily'));
    expect(outcome).toEqual({ ok: false, status: 400, error: message });
  });

  it('delete encodes loop-derived ids and returns the fresh list', async () => {
    call.mockResolvedValueOnce(json(200, { tasks: [task('b')] }));
    const outcome = await deleteScheduledTask('alpha', 'loop:project:daily');
    // ':' percent-encodes to %3A on the wire; the server's Hono param decode
    // then matches the stored `loop:project:daily` id (route suite p9-3d).
    expect(call).toHaveBeenCalledWith('/api/projects/alpha/scheduled-tasks/loop%3Aproject%3Adaily', { method: 'DELETE' });
    expect(outcome.ok && outcome.tasks.map((entry) => entry.id)).toEqual(['b']);
  });

  it('loop-file PATCH sends {enabled} and folds the gone-file 404', async () => {
    call.mockResolvedValueOnce(json(200, { task: task('t1', { enabled: true }) }));
    const outcome = await setLoopFileEnabled('alpha', 't1', true);
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/alpha/scheduled-tasks/t1/loop-file');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
    expect(outcome.ok && outcome.task.enabled).toBe(true);
    call.mockResolvedValueOnce(json(404, { error: 'loop file is gone' }));
    expect(await setLoopFileEnabled('alpha', 't1', false))
      .toEqual({ ok: false, status: 404, error: 'loop file is gone' });
  });

  it('loop-file DELETE returns the remaining tasks', async () => {
    call.mockResolvedValueOnce(json(200, { tasks: [] }));
    const outcome = await deleteLoopFile('alpha', 't1');
    expect(call).toHaveBeenCalledWith('/api/projects/alpha/scheduled-tasks/t1/loop-file', { method: 'DELETE' });
    expect(outcome).toEqual({ ok: true, tasks: [] });
  });

  it('run POST passes the C.7 result through and folds 400/409 refusals', async () => {
    const done = { ok: true, status: 'success' as const, sessionID: 'ses-9', task: task('t1'), persistError: undefined };
    call.mockResolvedValueOnce(json(200, done));
    const outcome = await runScheduledTask('alpha', 't1');
    expect(call).toHaveBeenCalledWith('/api/projects/alpha/scheduled-tasks/t1/run', { method: 'POST' });
    expect(outcome).toEqual({ ok: true, status: 'success', sessionID: 'ses-9', task: task('t1'), persistError: undefined });
    call.mockResolvedValueOnce(json(409, { error: 'task is already running or queued' }));
    expect(await runScheduledTask('alpha', 't1'))
      .toEqual({ ok: false, status: 409, error: 'task is already running or queued' });
    call.mockResolvedValueOnce(json(400, { error: 'unknown task' }));
    expect(await runScheduledTask('alpha', 'ghost')).toEqual({ ok: false, status: 400, error: 'unknown task' });
  });

  it('keeps the body-owned ok:false of a failed 200 run verbatim (C.7: ok folds the run result)', async () => {
    // The service answers a COMPLETED run that ERRORED with 200 + ok:false
    // (scheduled-run.ts finishRun); the client must not stamp ok:true over it.
    call.mockResolvedValueOnce(json(200, { ok: false, status: 'error', sessionID: 'ses-9', task: task('t1'), persistError: undefined }));
    const outcome = await runScheduledTask('alpha', 't1');
    expect(outcome).toEqual({ ok: false, status: 'error', sessionID: 'ses-9', task: task('t1'), persistError: undefined });
  });

  it('status rides the snapshot route and recovers the body shape', async () => {
    call.mockResolvedValueOnce(json(200, {
      running: { global: 2, byProject: { alpha: 2 } }, queued: 1,
      tasks: [{ projectId: 'alpha', id: 't1', name: 'daily', enabled: true, lastStatus: 'idle', nextRunAt: 42 }],
    }));
    const outcome = await schedulerStatus();
    expect(call).toHaveBeenCalledWith('/api/openchamber/scheduled-tasks/status', undefined);
    expect(outcome.ok && outcome.status.running.global).toBe(2);
    expect(outcome.ok && outcome.status.tasks[0]?.nextRunAt).toBe(42);
    expect(outcome.ok && 'ok' in outcome.status).toBe(false); // the flag is not part of the snapshot
  });

  it('a non-JSON failure body folds into a generic bounded error', async () => {
    call.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const outcome = await listScheduledTasks('alpha');
    expect(outcome).toEqual({ ok: false, status: 500, error: 'scheduled-task request failed (500)' });
  });

  it('folds a malformed null JSON failure body instead of crashing', async () => {
    call.mockResolvedValueOnce(json(400, null));
    expect(await listScheduledTasks('alpha'))
      .toEqual({ ok: false, status: 400, error: 'scheduled-task request failed (400)' });
  });

  it('a JSON error body survives even on 500 (sync/persist failures keep their detail)', async () => {
    call.mockResolvedValueOnce(json(500, { error: 'scheduled task sync failed: lock held' }));
    const outcome = await deleteScheduledTask('alpha', 't1');
    expect(outcome).toEqual({ ok: false, status: 500, error: 'scheduled task sync failed: lock held' });
  });
});

describe('parseTaskRunEvent (C.10 fanout)', () => {
  it('parses the wire payload with the sessionId wire name', () => {
    expect(parseTaskRunEvent(ranEvent({ projectId: 'alpha', taskId: 't1', ranAt: 99, status: 'success', sessionId: 'ses-9' })))
      .toEqual({ projectId: 'alpha', taskId: 't1', ranAt: 99, status: 'success', sessionId: 'ses-9' });
    expect(parseTaskRunEvent(ranEvent({ projectId: 'alpha', taskId: 't1', ranAt: 99, status: 'running' }))?.sessionId)
      .toBeUndefined();
  });

  it('rejects a foreign type, blanks, bad numbers, and out-of-family statuses', () => {
    expect(parseTaskRunEvent({ type: 'openchamber:system-resume', properties: {} })).toBeNull();
    expect(parseTaskRunEvent(ranEvent({ taskId: 't1', ranAt: 1, status: 'success' }))).toBeNull();
    expect(parseTaskRunEvent(ranEvent({ projectId: 'a', taskId: 't1', ranAt: 'x', status: 'success' }))).toBeNull();
    expect(parseTaskRunEvent(ranEvent({ projectId: 'a', taskId: 't1', ranAt: 1, status: 'idle' }))).toBeNull();
  });
});

describe('previewNextRuns (E-09-26 draft preview)', () => {
  it('POSTs {schedule, count, from} to the preview route and folds {slots}', async () => {
    const schedule: TaskSchedule = { kind: 'daily', times: ['08:30'], timezone: 'Europe/Berlin' };
    call.mockResolvedValueOnce(json(200, { slots: [1770000000000, 1770086400000] }));
    const outcome = await previewNextRuns(schedule, { count: 2, from: 1769990000000 });
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/openchamber/scheduled-tasks/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ schedule, count: 2, from: 1769990000000 });
    expect(outcome).toEqual({ ok: true, slots: [1770000000000, 1770086400000] });
  });

  it('omitted options stringify as the bare {schedule} body', async () => {
    call.mockResolvedValueOnce(json(200, { slots: [] }));
    await previewNextRuns({ kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' });
    const [, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ schedule: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' } });
  });

  it('a 200 with an empty prefix stays ok (invalid draft is not an error)', async () => {
    call.mockResolvedValueOnce(json(200, { slots: [] }));
    expect(await previewNextRuns({ kind: 'once', date: '2020-01-01', time: '09:00', timezone: 'UTC' }))
      .toEqual({ ok: true, slots: [] });
  });

  it('folds the registered shape-error 400', async () => {
    call.mockResolvedValueOnce(json(400, { error: 'schedule object is required' }));
    // A cast models a caller building the body from loose form state.
    expect(await previewNextRuns(null as unknown as TaskSchedule))
      .toEqual({ ok: false, status: 400, error: 'schedule object is required' });
  });

  it('weird options pass through: the server owns validation (no client clamp)', async () => {
    // Decision (E-09-26): the client does NOT clamp count/from. JSON.stringify
    // already makes NaN/Infinity `null`, and the route folds every unusable
    // count to the default 4 and every unusable `from` to now - one
    // validation authority instead of two windows that can drift apart.
    call.mockResolvedValueOnce(json(200, { slots: [1] }));
    const outcome = await previewNextRuns(
      { kind: 'daily', times: ['09:00'], timezone: 'UTC' } as TaskSchedule,
      { count: Number.NaN, from: Number.POSITIVE_INFINITY },
    );
    const [, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      count: null, from: null,
    });
    expect(outcome).toEqual({ ok: true, slots: [1] });
    call.mockResolvedValueOnce(json(200, { slots: [] }));
    await previewNextRuns({ kind: 'once', date: '2020-01-01', time: '09:00', timezone: 'UTC' }, { count: 0 });
    const [, zeroInit] = call.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(zeroInit.body))).toEqual({
      schedule: { kind: 'once', date: '2020-01-01', time: '09:00', timezone: 'UTC' }, count: 0,
    });
  });
});
