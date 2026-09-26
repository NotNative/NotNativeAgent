// SPDX-License-Identifier: Apache-2.0
/**
 * Per-project scheduled-task storage (doc 12 §C.1/§C.9). Tasks live in the
 * project config JSON (`<data-dir>/projects/<projectId>.json`) under
 * `scheduledTasks`. Every write is a locked whole-document rewrite after a
 * full fresh read (other config keys survive untouched), atomic tmp+rename.
 * A task this build did not modify stays VERBATIM on disk: state patches
 * swap only the `state` object onto the RAW stored record (a newer build's
 * task stays readable by us even when we cannot schedule its unknown
 * schedule kind), while `upsert` normalizes and replaces deliberately. A
 * patch value of `undefined` explicitly CLEARS a key (the claim clears a
 * past once slot; omitting the key would leave the stale value). The
 * required `updatedAt` is the exception: it falls back to now instead.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { ENV } from '../env.ts';
import { withConfigLock } from './config-lock.ts';
import { normalizeTaskForStorage, record, type NormalizeOptions, type NormalizeResult, type ScheduledTask } from './task-schema.ts';
import { PROJECT_ID_PATTERN, SCHEDULED_TASKS_KEY } from './scheduled-constants.ts';

const KEY = SCHEDULED_TASKS_KEY;

export function scheduledConfigPath(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error('projectId is malformed');
  return joinPath(ENV.dataDir, 'projects', `${projectId}.json`);
}

type RawDoc = { kind: 'missing' } | { kind: 'malformed' } | { kind: 'ok'; doc: Record<string, unknown> };

async function readRawDoc(path: string): Promise<RawDoc> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'malformed' };
  }
  try {
    const doc = JSON.parse(bytes) as unknown;
    const shaped = record(doc);
    return shaped !== null ? { kind: 'ok', doc: shaped } : { kind: 'malformed' };
  } catch {
    return { kind: 'malformed' };
  }
}

export function scheduledTempPath(path: string, stamp: number): string {
  return `${path}.tmp-${process.pid}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeDocAtomic(path: string, doc: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = scheduledTempPath(path, Date.now());
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

async function renameAsideMalformed(path: string): Promise<void> {
  try {
    await rename(path, `${path}.corrupt-${Date.now()}`);
  } catch { /* the file is gone between read and rename */ }
}

function tasksIn(doc: Record<string, unknown>): unknown[] {
  const value = doc[KEY];
  return Array.isArray(value) ? value : [];
}

function withTasks(rawDoc: Record<string, unknown>, next: unknown[], bumpVersion: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rawDoc, [KEY]: next };
  if (bumpVersion && out.version === undefined) out.version = 1;
  return out;
}

export interface TaskLoad { tasks: ScheduledTask[]; invalid: string[] }

export function parseTasks(entries: unknown[], options: NormalizeOptions): TaskLoad {
  const tasks: ScheduledTask[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const outcome = normalizeTaskForStorage(entry, options);
    if (outcome.ok) tasks.push(outcome.task);
    else invalid.push(outcome.reason);
  }
  return { tasks, invalid };
}

/** Fresh read (no lock): valid tasks for the scheduler's view, damaged
 * entries reported rather than killing the project's scheduling. */
export async function loadScheduledTasks(projectId: string, options: NormalizeOptions): Promise<TaskLoad> {
  const raw = await readRawDoc(scheduledConfigPath(projectId));
  if (raw.kind !== 'ok') {
    return { tasks: [], invalid: raw.kind === 'malformed' ? ['project config is malformed'] : [] };
  }
  return parseTasks(tasksIn(raw.doc), options);
}

function findIndex(entries: unknown[], taskId: string): number {
  for (let index = 0; index < entries.length; index += 1) {
    const task = record(entries[index]);
    if (task !== null && task.id === taskId) return index;
  }
  return -1;
}

/** Replaces or inserts one task (normalize + replace): id immutable. */
export async function upsertScheduledTask(
  projectId: string, input: unknown, options: NormalizeOptions,
): Promise<NormalizeResult> {
  const path = scheduledConfigPath(projectId);
  return withConfigLock(path, async (): Promise<NormalizeResult> => {
    const raw = await readRawDoc(path);
    const entries = raw.kind === 'ok' ? tasksIn(raw.doc) : [];
    const requested = record(input)?.id;
    const index = typeof requested === 'string' ? findIndex(entries, requested) : -1;
    const existing = index >= 0 ? record(entries[index]) : null;
    // Only base.id is consulted for the immutability rule (raw stored record).
    const base = existing === null ? undefined : (existing as never);
    const outcome = normalizeTaskForStorage(input, options, base);
    if (!outcome.ok) return outcome;
    const next = index >= 0
      ? entries.map((entry, at) => (at === index ? outcome.task : entry))
      : [...entries, outcome.task];
    if (raw.kind === 'malformed') {
      await renameAsideMalformed(path);
      await writeDocAtomic(path, withTasks({}, next, true));
      return outcome;
    }
    await writeDocAtomic(path, withTasks(raw.kind === 'ok' ? raw.doc : {}, next, true));
    return outcome;
  });
}

/** State patches swap ONLY the state object onto the raw record; an
 * `undefined` patch value clears the key (claim contract). */
export function applyStatePatch(
  stored: Record<string, unknown>, patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...record(stored.state), ...patch, updatedAt: patch.updatedAt ?? Date.now(),
  };
  for (const key of Object.keys(patch)) {
    // updatedAt is required on every stored state; its explicit-undefined
    // lands on the "now" default above, never clears the field on disk.
    if (key !== 'updatedAt' && patch[key] === undefined) delete merged[key];
  }
  return { ...stored, state: merged };
}

async function patchState(
  projectId: string, taskId: string, patch: Record<string, unknown>,
  predicate?: (task: Record<string, unknown>) => boolean,
): Promise<{ updated: boolean; task: Record<string, unknown> | null }> {
  const path = scheduledConfigPath(projectId);
  return withConfigLock(path, async () => {
    const raw = await readRawDoc(path);
    if (raw.kind !== 'ok') return { updated: false, task: null };
    const entries = tasksIn(raw.doc);
    const index = findIndex(entries, taskId);
    if (index < 0) return { updated: false, task: null };
    const stored = record(entries[index]) as Record<string, unknown>;
    if (predicate !== undefined && !predicate(stored)) {
      return { updated: false, task: stored };
    }
    const task = applyStatePatch(stored, patch);
    const next = entries.map((entry, at) => (at === index ? task : entry));
    await writeDocAtomic(path, withTasks(raw.doc, next, false));
    return { updated: true, task };
  });
}

export async function updateScheduledTaskState(
  projectId: string, taskId: string, patch: Record<string, unknown>,
): Promise<boolean> {
  return (await patchState(projectId, taskId, patch)).updated;
}

export async function updateScheduledTaskStateIf(
  projectId: string, taskId: string, predicate: (task: Record<string, unknown>) => boolean,
  patch: Record<string, unknown>,
): Promise<{ updated: boolean; task: Record<string, unknown> | null }> {
  return patchState(projectId, taskId, patch, predicate);
}

export async function removeScheduledTask(projectId: string, taskId: string): Promise<boolean> {
  const path = scheduledConfigPath(projectId);
  return withConfigLock(path, async (): Promise<boolean> => {
    const raw = await readRawDoc(path);
    if (raw.kind !== 'ok') return false;
    const entries = tasksIn(raw.doc);
    if (findIndex(entries, taskId) < 0) return false;
    await writeDocAtomic(path, withTasks(raw.doc,
      entries.filter((entry) => record(entry)?.id !== taskId), false));
    return true;
  });
}
