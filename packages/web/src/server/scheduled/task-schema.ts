// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task storage schema and validation (doc 12 §C.1). Writers
 * preserve every unknown field of a task verbatim (multi-version sharing),
 * overlaying only the normalized known fields; `schedule.kind`/`timezone`/
 * cron validity are really checked (Intl zone, cron-parser `next()`), not
 * merely shape-checked. Required fields reject on violation; state fields
 * and route/variant strings are dropped when malformed so one damaged field
 * cannot make an otherwise-valid stored task unreadable.
 */
import { TOKEN_BUDGET_MAX } from '../goals/goal-constants.ts';
import { cronNextAt, isValidZone, parseOnceSlot } from './next-run.ts';
import {
  TASK_CRON_MAX, TASK_ID_MAX, TASK_LAST_ERROR_MAX, TASK_NAME_MAX,
  TASK_PROMPT_MAX, TASK_ROUTE_ID_MAX,
} from './scheduled-constants.ts';

export type Schedule =
  | { kind: 'daily'; times: string[]; timezone: string; time?: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone: string }
  | { kind: 'once'; date: string; time: string; timezone: string }
  | { kind: 'cron'; cron: string; timezone: string };

export interface Execution {
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

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  loopFile?: string;
  schedule: Schedule;
  execution: Execution;
  state: TaskState;
  [key: string]: unknown;
}

export interface NormalizeOptions {
  now: number;
  serverZone: string;
}

export type NormalizeResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; reason: string };

const TASK_ID = /^[A-Za-z0-9._:-]{1,127}$/u;
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
const LAST_STATUSES = ['idle', 'running', 'success', 'error'] as const;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, max: number, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  return value;
}

function validRealDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const [y = 0, mo = 0, d = 0] = date.split('-').map((part) => Number(part));
  const stamp = new Date(Date.UTC(y, mo - 1, d, 12));
  return stamp.getUTCFullYear() === y && stamp.getUTCMonth() === mo - 1 && stamp.getUTCDate() === d;
}

function zoneOrDefault(value: unknown, options: NormalizeOptions): string {
  return typeof value === 'string' && isValidZone(value) ? value
    : isValidZone(options.serverZone) ? options.serverZone : 'UTC';
}

function realTimes(raw: Record<string, unknown>): { times: string[]; time?: string } | null {
  const legacy = typeof raw.time === 'string' && HH_MM.test(raw.time) ? raw.time : undefined;
  if (Array.isArray(raw.times)) {
    if (!raw.times.every((time): time is string => typeof time === 'string' && HH_MM.test(time))) return null;
    return { times: [...new Set(raw.times)].sort(), time: legacy };
  }
  return legacy === undefined ? null : { times: [legacy], time: legacy };
}

function normalizeSchedule(raw: unknown, options: NormalizeOptions): Schedule | null {
  const shape = record(raw);
  if (!shape) return null;
  const timezone = zoneOrDefault(shape.timezone, options);
  const base = { ...shape, timezone };
  switch (shape.kind) {
    case 'daily': {
      const parsed = realTimes(shape);
      if (!parsed) return null;
      const daily = { ...base, kind: 'daily', times: parsed.times } as Extract<Schedule, { kind: 'daily' }>;
      if (parsed.times.length === 1 && parsed.time !== undefined && shape.times === undefined) daily.time = parsed.time;
      else delete daily.time;
      return daily;
    }
    case 'weekly': {
      const parsed = realTimes(shape);
      const weekdays = Array.isArray(shape.weekdays)
        ? [...new Set(shape.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
        : [];
      if (!parsed || weekdays.length === 0) return null;
      return { ...base, kind: 'weekly', times: parsed.times, weekdays } as Extract<Schedule, { kind: 'weekly' }>;
    }
    case 'once': {
      if (typeof shape.date !== 'string' || !validRealDate(shape.date)) return null;
      if (typeof shape.time !== 'string' || !HH_MM.test(shape.time)) return null;
      if (!parseOnceSlot(shape.date, shape.time)) return null;
      return { ...base, kind: 'once', date: shape.date, time: shape.time } as Extract<Schedule, { kind: 'once' }>;
    }
    case 'cron': {
      if (typeof shape.cron !== 'string' || shape.cron.length === 0
        || shape.cron.length > TASK_CRON_MAX) return null;
      if (cronNextAt(shape.cron, timezone, options.now) === null) return null;
      return { ...base, kind: 'cron', cron: shape.cron } as Extract<Schedule, { kind: 'cron' }>;
    }
    default: return null;
  }
}

function normalizeExecution(raw: unknown): Execution | null {
  const shape = record(raw);
  if (!shape) return null;
  const prompt = boundedString(shape.prompt, TASK_PROMPT_MAX);
  const providerID = boundedString(shape.providerID, TASK_ROUTE_ID_MAX);
  const modelID = boundedString(shape.modelID, TASK_ROUTE_ID_MAX);
  if (!prompt || !providerID || !modelID) return null;
  const execution: Execution = { ...shape, prompt, providerID, modelID } as Execution;
  const variant = boundedString(shape.variant, TASK_ROUTE_ID_MAX);
  const agent = boundedString(shape.agent, TASK_ROUTE_ID_MAX);
  if (variant !== undefined) execution.variant = variant; else delete execution.variant;
  if (agent !== undefined) execution.agent = agent; else delete execution.agent;
  if (typeof shape.goalEnabled === 'boolean') {
    execution.goalEnabled = shape.goalEnabled;
  } else delete execution.goalEnabled;
  if (execution.goalEnabled && typeof shape.goalTokenBudget === 'number'
    && Number.isInteger(shape.goalTokenBudget) && shape.goalTokenBudget >= 0
    && shape.goalTokenBudget <= TOKEN_BUDGET_MAX) {
    execution.goalTokenBudget = shape.goalTokenBudget;
  } else delete execution.goalTokenBudget;
  if (typeof shape.permissionAutoAccept === 'boolean') {
    execution.permissionAutoAccept = shape.permissionAutoAccept;
  } else delete execution.permissionAutoAccept;
  return execution;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeState(raw: unknown, options: NormalizeOptions): TaskState {
  const shape = record(raw) ?? {};
  const createdAt = finite(shape.createdAt) && shape.createdAt >= 0 ? shape.createdAt : options.now;
  const updatedAt = finite(shape.updatedAt) && shape.updatedAt >= 0 ? shape.updatedAt : options.now;
  const lastStatus = (LAST_STATUSES as readonly string[]).includes(String(shape.lastStatus))
    ? shape.lastStatus as TaskState['lastStatus'] : 'idle';
  const state: TaskState = { ...shape, createdAt, updatedAt, lastStatus };
  if (finite(shape.lastRunAt)) state.lastRunAt = shape.lastRunAt; else delete state.lastRunAt;
  if (finite(shape.lastDurationMs) && shape.lastDurationMs >= 0) state.lastDurationMs = shape.lastDurationMs;
  else delete state.lastDurationMs;
  const sessionId = boundedString(shape.lastSessionId, TASK_ID_MAX);
  if (sessionId !== undefined) state.lastSessionId = sessionId; else delete state.lastSessionId;
  if (finite(shape.nextRunAt)) state.nextRunAt = shape.nextRunAt; else delete state.nextRunAt;
  if (finite(shape.lastScheduledFor)) state.lastScheduledFor = shape.lastScheduledFor;
  else delete state.lastScheduledFor;
  const lastError = boundedString(shape.lastError, TASK_LAST_ERROR_MAX);
  if (lastError !== undefined) state.lastError = lastError; else delete state.lastError;
  return state;
}

/**
 * Normalizes one stored task document. `base` is the previously stored task
 * for an update: the id is immutable and a mismatch rejects. Unknown fields
 * survive verbatim on task, schedule, execution, and state objects.
 */
export function normalizeTaskForStorage(raw: unknown, options: NormalizeOptions, base?: ScheduledTask): NormalizeResult {
  const shape = record(raw);
  if (!shape) return { ok: false, reason: 'task must be a JSON object' };
  const id = typeof shape.id === 'string' && TASK_ID.test(shape.id) ? shape.id : undefined;
  if (!id) return { ok: false, reason: 'task id is missing or malformed' };
  if (base !== undefined && typeof shape.id === 'string' && shape.id !== base.id) {
    return { ok: false, reason: 'task id is immutable' };
  }
  if (typeof shape.name !== 'string') return { ok: false, reason: 'task name is required' };
  const name = shape.name.trim();
  if (name.length === 0 || name.length > TASK_NAME_MAX) {
    return { ok: false, reason: 'task name must be 1..80 characters' };
  }
  if (typeof shape.enabled !== 'boolean') return { ok: false, reason: 'task enabled flag is required' };
  const schedule = normalizeSchedule(shape.schedule, options);
  if (!schedule) return { ok: false, reason: 'task schedule is invalid' };
  const execution = normalizeExecution(shape.execution);
  if (!execution) return { ok: false, reason: 'task execution is invalid' };
  const loopFile = boundedString(shape.loopFile, 1024);
  const task: ScheduledTask = {
    ...shape, id, name, enabled: shape.enabled, schedule, execution, state: undefined as never,
  };
  if (loopFile !== undefined) task.loopFile = loopFile; else delete task.loopFile;
  task.state = normalizeState(shape.state, options);
  return { ok: true, task };
}
