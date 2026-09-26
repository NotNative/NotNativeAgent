// SPDX-License-Identifier: Apache-2.0
/**
 * Per-process scheduling state (doc 12 §C.4): task maps, due timers, the FIFO
 * run queue and slot counters. Timers carry the slot they were armed FOR so a
 * late fire still claims the exact occurrence; overflow delays re-arm
 * recursively at the setTimeout cap instead of firing early.
 */
import { MAX_TIMEOUT_MS } from './scheduled-constants.ts';
import type { RunRequest, RuntimePorts } from './scheduled-ports.ts';
import { finiteOr, messageOf, optionalFinite } from './scheduled-util.ts';
import type { ScheduledTask } from './task-schema.ts';
import { computeNextRunAt } from './next-run.ts';

interface TimerEntry { handle: ReturnType<typeof setTimeout>; dueAt: number }

export function keyOf(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`;
}

export class ScheduledState {
  /** Set by the runtime: drains the run queue after a due fire enqueues. */
  afterEnqueue: (() => void) | null = null;
  /** True after stop() and until the next start(): the runtime stays inert,
   * so a run that settles afterward persists completion but arms nothing -
   * a timer or queue entry created after stop() would outlive it. */
  inert = false;
  readonly tasksByProject = new Map<string, Map<string, ScheduledTask>>();
  readonly timers = new Map<string, TimerEntry>();
  readonly queue: RunRequest[] = [];
  readonly queued = new Set<string>();
  readonly running = new Set<string>();
  globalRunning = 0;
  readonly projectRunning = new Map<string, number>();

  constructor(private readonly clock: { now: () => number; jitter: () => number }) {}

  memoryTask(projectId: string, taskId: string): ScheduledTask | null {
    return this.tasksByProject.get(projectId)?.get(taskId) ?? null;
  }

  remember(projectId: string, task: ScheduledTask): void {
    this.tasksByProject.get(projectId)?.set(task.id, task);
  }

  projectSlots(projectId: string): number {
    return this.projectRunning.get(projectId) ?? 0;
  }

  counts(): { global: number; byProject: Map<string, number> } {
    return { global: this.globalRunning, byProject: new Map(this.projectRunning) };
  }

  clearTimer(projectId: string, taskId: string): void {
    const key = keyOf(projectId, taskId);
    const entry = this.timers.get(key);
    if (entry) {
      clearTimeout(entry.handle);
      this.timers.delete(key);
    }
  }

  /** Arms the due timer; overflow delays re-arm recursively at the cap. */
  scheduleFutureRun(projectId: string, task: ScheduledTask, dueAt: number): void {
    this.clearTimer(projectId, task.id);
    if (this.inert || !task.enabled || !Number.isFinite(dueAt) || dueAt <= this.clock.now()) return;
    const key = keyOf(projectId, task.id);
    const delay = Math.max(0, dueAt - this.clock.now() + this.clock.jitter());
    if (delay > MAX_TIMEOUT_MS) {
      const handle = setTimeout(() => {
        this.timers.delete(key);
        this.scheduleFutureRun(projectId, task, dueAt);
      }, MAX_TIMEOUT_MS);
      this.timers.set(key, { handle, dueAt });
      return;
    }
    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.onDue(projectId, task.id, dueAt);
    }, delay);
    this.timers.set(key, { handle, dueAt });
  }

  onDue(projectId: string, taskId: string, scheduledFor: number): void {
    const task = this.memoryTask(projectId, taskId);
    if (task === null || !task.enabled) return;
    this.enqueue({ projectId, taskId, reason: 'scheduled', scheduledFor });
  }

  enqueue(request: RunRequest): boolean {
    if (this.inert) return false;
    const key = keyOf(request.projectId, request.taskId);
    if (this.queued.has(key) || this.running.has(key)) return false;
    this.queued.add(key);
    this.queue.push(request);
    if (this.afterEnqueue !== null) this.afterEnqueue();
    return true;
  }

  /** Drops timers (and optionally tasks) for projects gone from the list. */
  dropProjectsNotIn(known: Set<string>): void {
    for (const [key, entry] of this.timers) {
      if (!known.has(key.slice(0, key.indexOf(':')))) {
        clearTimeout(entry.handle);
        this.timers.delete(key);
        this.tasksByProject.delete(key.slice(0, key.indexOf(':')));
      }
    }
  }

  /** Drops tasks (and their timers) that vanished from a synced project. */
  dropTasksNotIn(projectId: string, knownIds: Set<string>): void {
    const prefix = `${projectId}:`;
    for (const [key, entry] of this.timers) {
      if (key.startsWith(prefix) && !knownIds.has(key.slice(prefix.length))) {
        clearTimeout(entry.handle);
        this.timers.delete(key);
      }
    }
  }

  clearForStop(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.handle);
    this.timers.clear();
    this.queue.splice(0, this.queue.length);
    this.queued.clear();
  }
}

/** §C.4 syncProject: read, replace the memory map, persist each computed
 * nextRunAt, and arm future slots. Store failures propagate to the caller. */
export async function syncScheduledProject(ports: RuntimePorts, state: ScheduledState, projectId: string): Promise<void> {
  const load = await ports.load(projectId);
  const map = new Map<string, ScheduledTask>();
  for (const task of load.tasks) map.set(task.id, task);
  state.tasksByProject.set(projectId, map);
  state.dropTasksNotIn(projectId, new Set(map.keys()));
  for (const task of map.values()) {
    const nextAt = computeNextRunAt(task.schedule, task.enabled, ports.now());
    await ports.patch(projectId, task.id,
      { nextRunAt: optionalFinite(nextAt), updatedAt: ports.now() });
    state.scheduleFutureRun(projectId, task, finiteOr(nextAt, -Infinity));
  }
}

/** §C.4 start(): sync every project; one broken project logs and skips. */
export async function syncAllScheduledProjects(ports: RuntimePorts, state: ScheduledState): Promise<boolean> {
  let projects: string[];
  try {
    projects = await ports.listProjects();
  } catch (error) {
    ports.log.error(`scheduled task sync aborted: ${String(error)}`);
    return false;
  }
  const known = new Set(projects);
  state.dropProjectsNotIn(known);
  for (const projectId of projects) {
    try {
      await syncScheduledProject(ports, state, projectId);
    } catch (error) {
      ports.log.warn(`scheduled project ${projectId} skipped: ${messageOf(error)}`);
    }
  }
  return true;
}
