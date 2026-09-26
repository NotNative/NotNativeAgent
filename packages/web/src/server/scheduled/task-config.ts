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
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { ENV } from '../env.ts';
import { withConfigLock } from './config-lock.ts';
import { LOOP_TASK_ID_PATTERN, loopTaskId, loopTaskInput, type DiscoveredLoop } from './loops.ts';
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

export function scheduledStoreExists(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId) && existsSync(scheduledConfigPath(projectId));
}

/** Loop-marked entries grouped by their driving file (identity = file path). */
function loopFileIndex(entries: unknown[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i += 1) {
    const file = record(entries[i])?.loopFile;
    if (typeof file !== 'string' || file.length === 0) continue;
    const list = index.get(file) ?? [];
    list.push(i);
    index.set(file, list);
  }
  return index;
}

/** At most one task per loop file (doc 12 C.8): keep the first pointer. */
function duplicatePointers(fileIndex: ReadonlyMap<string, number[]>): Set<number> {
  const drop = new Set<number>();
  for (const list of fileIndex.values()) {
    const keep = list[0];
    if (keep === undefined) continue;
    for (const extra of list) if (extra !== keep) drop.add(extra);
  }
  return drop;
}

/** Where a loop's definition lands: the entry pointing at its file
 * (file-owned; renames re-key the id), else a plain JSON task the loop
 * adopts by name (or by id; the stored id SURVIVES), else create. */
function loopTarget(entries: unknown[], loop: DiscoveredLoop, drop: ReadonlySet<number>): { at: number | null; fileOwned: boolean } {
  for (let i = 0; i < entries.length; i += 1) {
    if (drop.has(i)) continue;
    if (record(entries[i])?.loopFile === loop.file) return { at: i, fileOwned: true };
  }
  const expectedId = loopTaskId(loop);
  for (let i = 0; i < entries.length; i += 1) {
    if (drop.has(i)) continue;
    const entry = record(entries[i]);
    if (entry === null || typeof entry.loopFile === 'string') continue;
    if (entry.name === loop.name || entry.id === expectedId) return { at: i, fileOwned: false };
  }
  return { at: null, fileOwned: false };
}

/** C.8 table application: revive/ad/create/adopt for parsed loops, keep last
 * good definitions for name-bearing parse failures, prune orphaned and
 * duplicated pointers. Returns the ORIGINAL array when nothing changed. */
function applyLoopEntries(
  entries: unknown[], loops: readonly DiscoveredLoop[], options: NormalizeOptions,
  log?: { warn: (message: string) => void },
): unknown[] {
  const fileIndex = loopFileIndex(entries);
  const drop = duplicatePointers(fileIndex);
  const next = [...entries];
  let edited = false;
  for (const loop of loops) {
    if (loop.definition === null) continue;
    const target = loopTarget(entries, loop, drop);
    const stored = target.at === null ? undefined : record(entries[target.at]) ?? undefined;
    const storedId = typeof stored?.id === 'string' ? stored.id : undefined;
    // (E-09-23 f) a file-owned task re-keys to the fresh loop id only when
    // its name field changed or its stored id is already a stale loop
    // id; an adopted hand-made id survives every no-change reconcile.
    const renamed = typeof stored?.name === 'string' && stored.name !== loop.name;
    const derived = storedId !== undefined && LOOP_TASK_ID_PATTERN.test(storedId);
    const refreshedId = storedId === undefined ? undefined
      : target.fileOwned && storedId !== loopTaskId(loop) && (renamed || derived)
        ? loopTaskId(loop) : storedId;
    const input = loopTaskInput(loop, { stored, id: refreshedId });
    const outcome = normalizeTaskForStorage(input, options);
    if (!outcome.ok) {
      log?.warn(`loop revive refused for ${loop.file}: ${outcome.reason}`);
      continue;
    }
    if (target.at === null) next.push(outcome.task);
    else next[target.at] = outcome.task;
    edited = true;
  }
  const discovered = new Set(loops.map((loop) => loop.file));
  for (const [file, list] of fileIndex) {
    if (!discovered.has(file) && !drop.has(list[0] ?? -1)) drop.add(list[0] ?? -1);
  }
  if (!edited && drop.size === 0) return entries;
  const kept: unknown[] = [];
  for (let i = 0; i < next.length; i += 1) {
    if (!drop.has(i)) kept.push(next[i]);
  }
  return kept;
}

/** C.8 loop reconciliation, inside the project write lock. Files own their
 * tasks: revives refresh from the file (state + unknown fields ride along),
 * a rename re-keys the task to a fresh `loop:<scope>:<name>` id, a named
 * plain-task collision is adopted in place, and tasks whose file vanished
 * are dropped (plain JSON tasks never are). */
export async function reconcileLoopTasks(
  projectId: string, loops: readonly DiscoveredLoop[], options: NormalizeOptions,
  log?: { warn: (message: string) => void },
): Promise<TaskLoad> {
  const path = scheduledConfigPath(projectId);
  return withConfigLock(path, async (): Promise<TaskLoad> => {
    const raw = await readRawDoc(path);
    const entries = raw.kind === 'ok' ? tasksIn(raw.doc) : [];
    const next = applyLoopEntries(entries, loops, options, log);
    if (next === entries) return parseTasks(entries, options);
    if (raw.kind === 'malformed') {
      await renameAsideMalformed(path);
      await writeDocAtomic(path, withTasks({}, next, true));
      return parseTasks(next, options);
    }
    await writeDocAtomic(path, withTasks(raw.kind === 'ok' ? raw.doc : {}, next, true));
    return parseTasks(next, options);
  });
}
