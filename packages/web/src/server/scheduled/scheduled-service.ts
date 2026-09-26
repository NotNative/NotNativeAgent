// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task service wiring (doc 12 C.4/C.6/C.10): production ports over
 * the P9-3a task-config store, the C.6 pipeline adapter, and the C.10 SSE
 * fanout on the control bus. Lazy singleton like the message-queue runtime;
 * `bootScheduledTasks` starts it with the server, `stopScheduledTasks` sheds
 * timers on shutdown. The static `normalizeOptions` snapshot is a registered
 * edge: only hand-added tasks lacking `createdAt` would inherit the boot
 * timestamp (stored tasks always carry their own).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { publishControlEvent } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { NULL_KNOWLEDGE_PROVIDER } from '../queue/queue-hooks.ts';
import { ObjectiveStore } from '../goals/objective-store.ts';
import { serverZone } from './next-run.ts';
import { createHarnessReadyPoll, createNnaScheduledHarnessPorts } from './nna-scheduled-ports.ts';
import {
  createScheduledRunPipeline, type ScheduledHarnessPorts, type ScheduledPipelineDeps,
} from './scheduled-pipeline.ts';
import { createScheduledTasksRuntime, type RuntimePorts } from './scheduled-runtime.ts';
import type { StorePorts, TaskRunEvent } from './scheduled-ports.ts';
import {
  loadScheduledTasks, updateScheduledTaskState, updateScheduledTaskStateIf, upsertScheduledTask,
} from './task-config.ts';
import type { NormalizeOptions } from './task-schema.ts';

const scheduledLog = {
  warn: (message: string): void => { console.warn(`[scheduled] ${message}`); },
  error: (message: string): void => { console.error(`[scheduled] ${message}`); },
};

export function scheduledNormalizeOptions(): NormalizeOptions {
  return { now: Date.now(), serverZone: serverZone() };
}

/** Comma-free project id stems discoverable from the store directory;
 *  unreadable or missing directory means nothing is scheduled. */
export async function listScheduledProjects(
  projectsDir: string = join(ENV.dataDir, 'projects'),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (/^[A-Za-z0-9_-]+\.json$/u.test(entry)) ids.push(entry.slice(0, -5));
  }
  return ids.sort();
}

export function createScheduledStorePorts(): StorePorts {
  return {
    load: (projectId) => loadScheduledTasks(projectId, scheduledNormalizeOptions()),
    patch: (projectId, taskId, patch) => updateScheduledTaskState(projectId, taskId, patch),
    patchIf: (projectId, taskId, predicate, patch) =>
      updateScheduledTaskStateIf(projectId, taskId, predicate, patch),
    consumeOnce: async (projectId, task) => {
      await upsertScheduledTask(projectId, { ...task, enabled: false }, scheduledNormalizeOptions());
    },
    readLatest: async (projectId, taskId) => {
      const loaded = await loadScheduledTasks(projectId, scheduledNormalizeOptions());
      return loaded.tasks.find((task) => task.id === taskId) ?? null;
    },
  };
}

/** C.10 fanout: `{ projectId, taskId, ranAt, status, sessionId? }` on the
 *  branded control event; the wire name is `sessionId` (C.10), the internal
 *  event field stays `sessionID`. */
export function emitTaskRunEvent(event: TaskRunEvent): void {
  publishControlEvent({
    type: CONTROL_EVENTS.scheduledTaskRan,
    payload: {
      projectId: event.projectId, taskId: event.taskId, ranAt: event.ranAt, status: event.status,
      ...(event.sessionID !== undefined ? { sessionId: event.sessionID } : {}),
    },
  });
}

export function createScheduledPipelineDeps(
  harness: ScheduledHarnessPorts = createNnaScheduledHarnessPorts(),
): ScheduledPipelineDeps {
  return {
    harness,
    knowledge: NULL_KNOWLEDGE_PROVIDER,
    emitRunning: (event) => emitTaskRunEvent({ ...event, status: 'running' }),
    waitForReady: createHarnessReadyPoll(),
    expandPrompt: async (text) => text,
    objectiveStore: new ObjectiveStore(),
    log: scheduledLog,
    now: () => Date.now(),
  };
}

export type ScheduledTasksRuntime = ReturnType<typeof createScheduledTasksRuntime>;

let defaultRuntime: ScheduledTasksRuntime | null = null;

/** Lazy production singleton: owns the per-project config stores, the run
 *  pipeline adapter, and the control-bus event fanout. */
export function getScheduledTasksRuntime(): ScheduledTasksRuntime {
  if (!defaultRuntime) {
    const ports: RuntimePorts = {
      ...createScheduledStorePorts(),
      listProjects: () => listScheduledProjects(),
      runPipeline: createScheduledRunPipeline(createScheduledPipelineDeps()),
      emit: emitTaskRunEvent,
      log: scheduledLog,
      now: () => Date.now(),
      jitter: () => Math.floor(Math.random() * 2000),
      normalizeOptions: scheduledNormalizeOptions(),
    };
    const runtime = createScheduledTasksRuntime(ports);
    void runtime.start().catch((error: unknown) => {
      scheduledLog.warn(`scheduled task sync aborted: ${String(error)}`);
    });
    defaultRuntime = runtime;
  }
  return defaultRuntime;
}

export function bootScheduledTasks(): void {
  try {
    getScheduledTasksRuntime();
  } catch (error) {
    console.warn(`scheduled tasks boot failed: ${String(error)}`);
  }
}

export function stopScheduledTasks(): void {
  if (defaultRuntime !== null) {
    defaultRuntime.stop();
    defaultRuntime = null;
  }
}
