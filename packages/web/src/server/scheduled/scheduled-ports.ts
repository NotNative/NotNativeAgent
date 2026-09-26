// SPDX-License-Identifier: Apache-2.0
/**
 * Ports and shared result shapes for the scheduled-task runtime (doc 12 §C.4).
 * The runtime owns timing, claiming, bookkeeping, completion persistence and
 * events; the harness-facing pipeline (session create, prompt, goal planting)
 * is injected behind `runPipeline` so the runtime never imports the harness.
 */
import type { NormalizeOptions, ScheduledTask } from './task-schema.ts';
import type { DiscoveredLoop } from './loops.ts';

export interface TaskRunEvent {
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionID?: string;
}

export interface RunRequest {
  projectId: string;
  taskId: string;
  reason: 'scheduled' | 'manual';
  scheduledFor?: number;
}

export interface PipelineOutcome {
  sessionID?: string;
  /** C.6 step 11 return shape (extra fields are ignored by the runtime). */
  durationMs?: number;
  reason?: 'scheduled' | 'manual';
  startedAt?: number;
  finishedAt?: number;
}

export interface RunOutcome {
  ok: boolean;
  status?: 'success' | 'error';
  skipped?: boolean;
  reason?: string;
  sessionID?: string;
  task?: ScheduledTask;
  persistError?: string;
}

export interface StorePorts {
  load: (projectId: string) => Promise<{ tasks: ScheduledTask[]; invalid: string[] }>;
  patch: (projectId: string, taskId: string, patch: Record<string, unknown>) => Promise<boolean>;
  patchIf: (projectId: string, taskId: string, predicate: (task: Record<string, unknown>) => boolean,
    patch: Record<string, unknown>) => Promise<{ updated: boolean; task: Record<string, unknown> | null }>;
  consumeOnce: (projectId: string, task: ScheduledTask) => Promise<void>;
  readLatest: (projectId: string, taskId: string) => Promise<ScheduledTask | null>;
}

export interface RuntimePorts extends StorePorts {
  listProjects: () => Promise<string[]>;
  runPipeline: (request: RunRequest, task: ScheduledTask) => Promise<PipelineOutcome>;
  emit: (event: TaskRunEvent) => void;
  log: { warn: (message: string) => void; error: (message: string) => void };
  now: () => number;
  jitter: () => number;
  normalizeOptions: NormalizeOptions;
  /** C.8 seam, optional: discovery of the project's .agents/loops files and
   * the locked reconciliation they drive. `loopsFor` returns null when the
   * project path is unknown (no reconcile runs; plain sync proceeds). */
  loopsFor?: (projectId: string) => Promise<readonly DiscoveredLoop[] | null>;
  reconcileLoops?: (projectId: string, loops: readonly DiscoveredLoop[]) => Promise<void>;
}

export interface RuntimeLimits {
  maxGlobalConcurrency?: number;
  maxProjectConcurrency?: number;
  maxRunDurationMs?: number;
}
