// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task route family (doc 03 §5.16, depth in doc 12 C.4/C.8/C.9):
 * list, upsert, delete, the loop-file file mutations, the manual run-now
 * with the service-layer 400/409 mapping, and the scheduler status. All
 * registered BEFORE the generic harness proxy, behind the global /api gate.
 * Interpretations registered in NOTES E-09-23: a malformed projectId is a
 * 400 and an unknown project (no store file on disk) is the doc's "invalid
 * project" 404; the general task routes refuse loop-owned identities whose
 * file is still present (a mid-edit file refuses too - the file stays
 * authoritative; the id and file axes of a DISCOVERED loop refuse the
 * same way - the name axis alone would let the reconcile hijack the
 * just-upserted task), and an orphaned loop task deletes normally.
 */
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { record, type ScheduledTask } from '../scheduled/task-schema.ts';
import {
  loadScheduledTasks, removeScheduledTask, scheduledStoreExists, upsertScheduledTask,
} from '../scheduled/task-config.ts';
import {
  createScheduledLoopPorts, getScheduledTasksRuntime, runScheduledTaskNow, schedulerStatusOf,
  scheduledNormalizeOptions, type ScheduledTasksRuntime,
} from '../scheduled/scheduled-service.ts';
import { PROJECT_ID_PATTERN } from '../scheduled/scheduled-constants.ts';
import { writeLoopEnabled, loopTaskId, type DiscoveredLoop } from '../scheduled/loops.ts';
import { computeNextRunAt } from '../scheduled/next-run.ts';
import type { Schedule } from '../scheduled/task-schema.ts';

const BODY_MAX = 256 * 1024;
/** The preview `from` window: [1970-01-01, 9999-12-31T23:59:59.999Z]. `from`
 * inside it is honored; anything else folds to now — the same fold a
 * non-number takes. computeNextRunAt builds zone WALL-CLOCK candidates
 * internally, so instants near the ±10^8-day Date range overflow into
 * invalid intermediate dates (an Intl RangeError) that the real armer can
 * never see, because the armer always computes from the wall clock of now. */
const PREVIEW_EPOCH_MAX = 253402300799999;

type LoopResolver = (projectId: string) => Promise<readonly DiscoveredLoop[] | null>;

export interface ScheduledRouteOptions {
  /** Loop scan for the route's loop-ownership gates (production rides the
   * harness tree; tests inject). Null = unknown path, no gates. */
  loopsFor?: LoopResolver;
}

function fail(c: Context, status: 400 | 404 | 409 | 500, message: string): Response {
  return c.json({ error: message }, status);
}

function acceptedProject(c: Context): { projectId: string } | Response {
  const projectId = c.req.param('projectId') ?? '';
  const pattern = PROJECT_ID_PATTERN.test(projectId);
  if (!pattern) return fail(c, 400, 'unsupported characters in projectId');
  if (!scheduledStoreExists(projectId)) return fail(c, 404, 'unknown project');
  return { projectId };
}

function routeWarn(message: string): void {
  console.warn(`[scheduled] ${message}`);
}

async function readTaskBody(c: Context): Promise<Record<string, unknown> | null> {
  return record(await readJsonBodyBounded(c.req.raw, BODY_MAX));
}

async function freshTasks(projectId: string): Promise<ScheduledTask[]> {
  return (await loadScheduledTasks(projectId, scheduledNormalizeOptions())).tasks;
}

async function syncRuntime(
  provider: () => ScheduledTasksRuntime | null, projectId: string,
): Promise<void> {
  const runtime = provider();
  if (runtime !== null) await runtime.syncProject(projectId);
}

/** The loop-ownership gate for the general task routes: a requested task
 * whose id/name/file hits a still-present loop file is file-driven. */
async function loopGateViolation(
  projectId: string, task: Record<string, unknown>, loops: readonly DiscoveredLoop[] | null,
): Promise<string | null> {
  if (loops === null) return null;
  const requestedId = typeof task.id === 'string' ? task.id : '';
  const requestedName = typeof task.name === 'string' ? task.name.trim() : '';
  const requestedFile = typeof task.loopFile === 'string' ? task.loopFile : '';
  for (const existing of await freshTasks(projectId)) {
    const owned = existing.loopFile !== undefined && existsSync(existing.loopFile);
    const hit = existing.id === requestedId || (requestedName !== '' && existing.name === requestedName)
      || (requestedFile !== '' && existing.loopFile === requestedFile);
    if (owned && hit) return `task is driven by the loop file ${existing.loopFile}; mutate the file via the loop-file route`;
  }
  for (const loop of loops) {
    if (requestedFile !== '' && loop.file === requestedFile) {
      return `the loop file ${loop.file} owns this task; mutate the file via the loop-file route`;
    }
    if (requestedId !== '' && loopTaskId(loop) === requestedId) {
      return `a loop file owns this task id: ${loop.file}`;
    }
    if (loop.name === requestedName) {
      return `a loop file defines this name: ${loop.file}${loop.reason === undefined ? '' : ` (${loop.reason})`}`;
    }
  }
  return null;
}

async function listTasksHandler(c: Context, provider: () => ScheduledTasksRuntime | null): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const load = await loadScheduledTasks(project.projectId, scheduledNormalizeOptions());
  for (const reason of load.invalid) routeWarn(`unreadable stored task skipped: ${reason}`);
  return c.json({ tasks: load.tasks });
}

async function upsertTaskHandler(
  c: Context, provider: () => ScheduledTasksRuntime | null, loopsFor: LoopResolver,
): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const body = await readTaskBody(c);
  if (body === null || record(body.task) === null) return fail(c, 400, 'upsert requires a task object');
  const task = record(body.task) as Record<string, unknown>;
  const violation = await loopGateViolation(project.projectId, task, await loopsFor(project.projectId));
  if (violation !== null) return fail(c, 400, violation);
  const outcome = await upsertScheduledTask(project.projectId, task, scheduledNormalizeOptions());
  if (!outcome.ok) return fail(c, 400, outcome.reason);
  try {
    await syncRuntime(provider, project.projectId);
  } catch (error) {
    return fail(c, 500, `scheduled task sync failed: ${String(error).slice(0, 200)}`);
  }
  return c.json(outcome.task);
}

async function deleteTaskHandler(c: Context, provider: () => ScheduledTasksRuntime | null): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const taskId = c.req.param('taskId') ?? '';
  const task = (await freshTasks(project.projectId)).find((entry) => entry.id === taskId) ?? null;
  if (task === null) return fail(c, 404, 'unknown task');
  if (task.loopFile !== undefined && existsSync(task.loopFile)) {
    return fail(c, 400, `the loop file ${task.loopFile} still drives this task; delete the loop file (DELETE .../loop-file)`);
  }
  if (!await removeScheduledTask(project.projectId, taskId)) return fail(c, 404, 'unknown task');
  try {
    await syncRuntime(provider, project.projectId);
  } catch (error) {
    return fail(c, 500, `scheduled task sync failed: ${String(error).slice(0, 200)}`);
  }
  return c.json({ tasks: await freshTasks(project.projectId) });
}

async function findLoopTask(c: Context, projectId: string): Promise<{ task: ScheduledTask } | Response> {
  const taskId = c.req.param('taskId') ?? '';
  const task = (await freshTasks(projectId)).find((entry) => entry.id === taskId) ?? null;
  if (task === null) return fail(c, 404, 'unknown task');
  if (task.loopFile === undefined) return fail(c, 400, 'task is not loop-sourced');
  return { task };
}

async function patchLoopFileHandler(
  c: Context, provider: () => ScheduledTasksRuntime | null,
): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const found = await findLoopTask(c, project.projectId);
  if (found instanceof Response) return found;
  const body = await readTaskBody(c);
  const enabled = record(body)?.enabled;
  if (typeof enabled !== 'boolean') return fail(c, 400, 'loop-file toggle requires { enabled: boolean }');
  if (!existsSync(found.task.loopFile as string)) return fail(c, 404, 'loop file is gone');
  let text: string;
  try {
    text = await readFile(found.task.loopFile as string, 'utf8');
    const rewritten = writeLoopEnabled(text, enabled);
    if (rewritten === null) return fail(c, 400, 'loop file has no frontmatter block');
    await writeFile(found.task.loopFile as string, rewritten, 'utf8');
  } catch (error) {
    return fail(c, 500, `loop file write failed: ${String(error).slice(0, 200)}`);
  }
  try {
    // The file is authoritative: the sync's C.8 reconcile applies it.
    await syncRuntime(provider, project.projectId);
  } catch (error) {
    return fail(c, 500, `scheduled task sync failed: ${String(error).slice(0, 200)}`);
  }
  const task = (await freshTasks(project.projectId)).find((entry) => entry.id === found.task.id) ?? null;
  if (task === null) return fail(c, 404, 'task vanished during reconcile');
  return c.json({ task });
}

async function deleteLoopFileHandler(
  c: Context, provider: () => ScheduledTasksRuntime | null,
): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const found = await findLoopTask(c, project.projectId);
  if (found instanceof Response) return found;
  const file = found.task.loopFile as string;
  try {
    await unlink(file);
  } catch (error) {
    // A loop-marked task is an orphan once its file is gone; the next
    // sync's prune finishes what the user started.
    if ((error as { code?: string }).code !== 'ENOENT') {
      return fail(c, 500, `loop file delete failed: ${String(error).slice(0, 200)}`);
    }
  }
  try {
    await syncRuntime(provider, project.projectId);
  } catch (error) {
    return fail(c, 500, `scheduled task sync failed: ${String(error).slice(0, 200)}`);
  }
  return c.json({ tasks: await freshTasks(project.projectId) });
}

async function runTaskHandler(
  c: Context, provider: () => ScheduledTasksRuntime | null,
): Promise<Response> {
  const project = acceptedProject(c);
  if (project instanceof Response) return project;
  const runtime = provider();
  if (runtime === null) return fail(c, 500, 'scheduled tasks runtime is not running');
  const result = await runScheduledTaskNow(runtime, project.projectId, c.req.param('taskId') ?? '');
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 409);
  return c.json(result);
}

/** Editor preview (doc 12 §C.2 "next-4-runs preview", E-09-26): the draft
 *  schedule runs through the SAME `computeNextRunAt` the armer uses, so
 *  what the preview shows is what will arm. Invalid drafts answer the
 *  collected prefix (possibly empty), never an error - the UI renders
 *  "unavailable" instead. The bounded reader folds malformed, oversize and
 *  non-object bodies into one 400 (the reader's registered null fold). */
async function previewScheduleHandler(c: Context): Promise<Response> {
  const body = await readJsonBodyBounded(c.req.raw, 64 * 1024);
  if (body === null) return fail(c, 400, 'preview body must be an object');
  const { schedule, count, from } = body;
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) {
    return fail(c, 400, 'schedule object is required');
  }
  const want = typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 4 ? count : 4;
  const start = typeof from === 'number' && Number.isFinite(from) && from >= 0
    && from <= PREVIEW_EPOCH_MAX ? from : Date.now();
  const slots: number[] = [];
  let cursor = start;
  for (let index = 0; index < want; index += 1) {
    const next = computeNextRunAt(schedule as Schedule, true, cursor);
    if (next === null) break;
    slots.push(next);
    cursor = next + 1;
  }
  return c.json({ slots });
}

export function createScheduledTaskRoutes(
  provider: () => ScheduledTasksRuntime | null = getScheduledTasksRuntime,
  options: ScheduledRouteOptions = {},
): Hono {
  const loopsFor: LoopResolver = options.loopsFor ?? createScheduledLoopPorts().loopsFor;
  const app = new Hono();
  app.get('/api/projects/:projectId/scheduled-tasks', (c) => listTasksHandler(c, provider));
  app.put('/api/projects/:projectId/scheduled-tasks', (c) => upsertTaskHandler(c, provider, loopsFor));
  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', (c) => deleteTaskHandler(c, provider));
  app.patch('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', (c) => patchLoopFileHandler(c, provider));
  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', (c) => deleteLoopFileHandler(c, provider));
  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', (c) => runTaskHandler(c, provider));
  app.post('/api/openchamber/scheduled-tasks/preview', (c) => previewScheduleHandler(c));
  app.get('/api/openchamber/scheduled-tasks/status', (c) => c.json(schedulerStatusOf(provider())));
  return app;
}
