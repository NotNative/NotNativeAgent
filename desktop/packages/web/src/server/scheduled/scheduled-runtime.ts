// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task runtime entry point (doc 12 §C.4). Composes the per-process
 * scheduling state, the FIFO run queue with global/per-project slots, the run
 * controller, and project sync, then exposes start/stop/sync/runNow. Past
 * slots are never re-armed (a missed run is skipped, not caught up), one
 * unreadable project is skipped with a log, and a vanishing project sheds its
 * timers.
 */
import type { RuntimeLimits, RuntimePorts } from './scheduled-ports.ts';
import { createRunController, createRunPump } from './scheduled-run.ts';
import {
  ScheduledState, syncAllScheduledProjects, syncScheduledProject,
} from './scheduled-state.ts';

export type {
  PipelineOutcome, RunOutcome, RunRequest, RuntimeLimits, RuntimePorts,
  StorePorts, TaskRunEvent,
} from './scheduled-ports.ts';

export function createScheduledTasksRuntime(ports: RuntimePorts, limits: RuntimeLimits = {}) {
  const effective: Required<RuntimeLimits> = {
    maxGlobalConcurrency: limits.maxGlobalConcurrency ?? 4,
    maxProjectConcurrency: limits.maxProjectConcurrency ?? 2,
    maxRunDurationMs: limits.maxRunDurationMs ?? 30 * 60 * 1000,
  };
  const state = new ScheduledState({ now: ports.now, jitter: ports.jitter });
  const controller = createRunController({ ports, state, limits: effective, pump });
  const pumpCtl = createRunPump({
    state, runTask: controller.runTask, limits: effective, log: ports.log,
  });
  state.afterEnqueue = pumpCtl.pump;

  /** Kept as a stable reference point for the controller's settled paths. */
  function pump(): void {
    pumpCtl.pump();
  }

  /** stop(): shed timers and queued work, then stay inert - a run that
   * settles afterward persists its completion but arms nothing, and new
   * scheduled work is refused until the next start(). */
  function stop(): void {
    state.inert = true;
    state.clearForStop();
  }

  return {
    start: async () => {
      state.inert = false; // restart re-arms the future slots during sync
      return syncAllScheduledProjects(ports, state);
    },
    stop,
    syncProject: (projectId: string) => syncScheduledProject(ports, state, projectId),
    runNow: controller.runNow,
    enqueue: pumpCtl.enqueue,
    internals: {
      tasksByProject: state.tasksByProject,
      timers: state.timers,
      queue: state.queue,
      queued: state.queued,
      running: state.running,
      counts: () => state.counts(),
      scheduleFutureRun: (projectId: string, task: Parameters<typeof state.scheduleFutureRun>[1], dueAt: number) =>
        state.scheduleFutureRun(projectId, task, dueAt),
      onDue: (projectId: string, taskId: string, scheduledFor: number) =>
        state.onDue(projectId, taskId, scheduledFor),
      runTask: controller.runTask,
    },
  };
}
