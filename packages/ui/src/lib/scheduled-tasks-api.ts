// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task client (doc 03 §5.16; storage types doc 12 §C.1). Typed
 * CRUD + the manual run + loop-file endpoints + the scheduler status, all
 * on the app origin (`/api/projects/:id/scheduled-tasks*` and the status
 * snapshot). The C.10 control-event name the UI refreshes on is exported
 * here; the SSE plumbing itself lives in `lib/nnd/events.ts`.
 */
import { runtimeFetch } from './runtime-fetch.ts';
import type { HarnessEvent } from './nnd/events.ts';

/** §C.1 schedule union (stored normalized shape, mirrored verbatim). */
export type TaskSchedule =
  | { kind: 'daily'; times: string[]; timezone: string; time?: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone: string }
  | { kind: 'once'; date: string; time: string; timezone: string }
  | { kind: 'cron'; cron: string; timezone: string };

export interface TaskExecution {
  prompt: string;
  providerID: string;
  modelID: string;
  variant?: string;
  agent?: string;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
  permissionAutoAccept?: boolean;
}

export interface TaskState {
  createdAt: number;
  updatedAt: number;
  lastStatus: 'idle' | 'running' | 'success' | 'error';
  lastRunAt?: number;
  lastDurationMs?: number;
  lastSessionId?: string;
  nextRunAt?: number;
  lastScheduledFor?: number;
  lastError?: string;
}

/** The normalized wire record (unknown fields ride through untouched). */
export interface ScheduledTaskView {
  id: string;
  name: string;
  enabled: boolean;
  loopFile?: string;
  schedule: TaskSchedule;
  execution: TaskExecution;
  state: TaskState;
  [key: string]: unknown;
}

/** A PUT body as the server tolerates it: normalize() is the authority and
 * seeds `state` (createdAt/updatedAt = now, lastStatus idle) so a CREATE
 * payload may omit it; every other required field still must be present. */
export type ScheduledTaskInput = Omit<ScheduledTaskView, 'state'> & { state?: TaskState | undefined };

/** GET /api/openchamber/scheduled-tasks/status (E-09-23 j). */
export interface SchedulerStatus {
  running: { global: number; byProject: Record<string, number> };
  queued: number;
  tasks: Array<{
    projectId: string;
    id: string;
    name: string;
    enabled: boolean;
    lastStatus: TaskState['lastStatus'];
    nextRunAt?: number;
  }>;
}

/** POST .../run 200 body: the C.7 result — `ok:false` at 200 is a completed
 * run that ERRORED (the refusals are the 400/409 ApiFailure arm). */
export interface TaskRunResult {
  ok: boolean;
  status: TaskState['lastStatus'];
  sessionID?: string;
  task?: ScheduledTaskView;
  persistError?: string;
}

/** `{ok:false}` folds every non-200 into a status + bounded message. */
export type ApiFailure = { ok: false; status: number; error: string };

async function apiJson<T>(url: string, init?: RequestInit): Promise<(T & { ok: true }) | ApiFailure> {
  const response = await runtimeFetch(url, init);
  const parsed = await response.json().catch(() => null) as unknown;
  const body = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (!response.ok) {
    return { ok: false, status: response.status, error: typeof body.error === 'string' ? body.error : `scheduled-task request failed (${response.status})` };
  }
  // The run-now 200 body carries its OWN `ok` (C.7 via finishRun: ok:false
  // marks a completed run that ERRORED; the refusals are 400/409). Stamp our
  // envelope flag only when the body does not speak for itself.
  return (typeof body.ok === 'boolean' ? { ...body } : { ...body, ok: true }) as T & { ok: true };
}

function urlOf(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks${suffix}`;
}

export function listScheduledTasks(
  projectId: string,
): Promise<{ ok: true; tasks: ScheduledTaskView[] } | ApiFailure> {
  return apiJson(urlOf(projectId));
}

/** PUT stores + normalizes; the loop-ownership gates answer 400 (E-09-23 h).
 * The 200 body IS the stored task (no envelope, unlike the loop PATCH). */
export async function upsertScheduledTask(
  projectId: string, task: ScheduledTaskInput,
): Promise<{ ok: true; task: ScheduledTaskView } | ApiFailure> {
  const outcome = await apiJson<ScheduledTaskView>(urlOf(projectId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task }),
  });
  if (!outcome.ok) return outcome;
  const { ok: _ok, ...stored } = outcome as ScheduledTaskView & { ok: boolean };
  return { ok: true, task: stored as ScheduledTaskView };
}

export function deleteScheduledTask(
  projectId: string, taskId: string,
): Promise<{ ok: true; tasks: ScheduledTaskView[] } | ApiFailure> {
  return apiJson(urlOf(projectId, `/${encodeURIComponent(taskId)}`), { method: 'DELETE' });
}

/** The file is authoritative: the sync's C.8 reconcile applies the toggle. */
export function setLoopFileEnabled(
  projectId: string, taskId: string, enabled: boolean,
): Promise<{ ok: true; task: ScheduledTaskView } | ApiFailure> {
  return apiJson(urlOf(projectId, `/${encodeURIComponent(taskId)}/loop-file`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** Removing the file orphans the loop-marked task; the sync prunes it. */
export function deleteLoopFile(
  projectId: string, taskId: string,
): Promise<{ ok: true; tasks: ScheduledTaskView[] } | ApiFailure> {
  return apiJson(urlOf(projectId, `/${encodeURIComponent(taskId)}/loop-file`), { method: 'DELETE' });
}

export function runScheduledTask(
  projectId: string, taskId: string,
): Promise<TaskRunResult | ApiFailure> {
  return apiJson(urlOf(projectId, `/${encodeURIComponent(taskId)}/run`), { method: 'POST' });
}

/** Editor preview (E-09-26): POSTs the DRAFT schedule; the server runs it
 * through the same computeNextRunAt the armer uses, so shown = armed. A
 * 200 with an invalid draft carries an empty (prefix) `slots`, not an error. */
export function previewNextRuns(
  schedule: TaskSchedule, options: { count?: number; from?: number } = {},
): Promise<{ ok: true; slots: number[] } | ApiFailure> {
  return apiJson<{ slots: number[] }>('/api/openchamber/scheduled-tasks/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schedule, count: options.count, from: options.from }),
  });
}

export async function schedulerStatus(): Promise<{ ok: true; status: SchedulerStatus } | ApiFailure> {
  // The body IS the status snapshot; apiJson attaches the `ok` flag beside it.
  const outcome = await apiJson<SchedulerStatus>('/api/openchamber/scheduled-tasks/status');
  if (!outcome.ok) return outcome;
  const { ok: _ok, ...status } = outcome as SchedulerStatus & { ok: boolean };
  return { ok: true, status };
}

/** C.10 fanout: the wire name mirrors `notnative:scheduled-task-ran`. */
export const SCHEDULED_TASK_RAN = 'notnative:scheduled-task-ran';

export interface TaskRunEventView {
  projectId: string;
  taskId: string;
  ranAt: number;
  status: TaskState['lastStatus'];
  sessionId?: string;
}

/** The control-event payload parser; `sessionId` is the wire name (C.10). */
export function parseTaskRunEvent(event: HarnessEvent): TaskRunEventView | null {
  if (event.type !== SCHEDULED_TASK_RAN) return null;
  const payload = (event.properties ?? {}) as Record<string, unknown>;
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
  const ranAt = typeof payload.ranAt === 'number' && Number.isFinite(payload.ranAt) ? payload.ranAt : NaN;
  const status = payload.status === 'running' || payload.status === 'success' || payload.status === 'error'
    ? payload.status : null;
  if (projectId.length === 0 || taskId.length === 0 || !Number.isFinite(ranAt) || status === null) return null;
  return {
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
  };
}
