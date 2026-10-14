// SPDX-License-Identifier: Apache-2.0
/**
 * Run control (doc 12 §C.5/C.6/C.7): the task dispatcher, the manual run
 * entry, and the queue pump. A scheduled run claims its occurrence in the
 * shared config BEFORE dispatch (the claim, phase advances, dispatch, and
 * boot resume live in scheduled-occurrence.ts); a manual run writes a running
 * status without claim fields. A completion persist failure gets exactly ONE
 * best-effort retry before the controller falls back to the in-memory task
 * for the terminal state (scheduled-settle.ts owns that path).
 */
import { buildManualStartPatch } from './scheduled-claims.ts';
import { resumeOccurrence, runScheduled } from './scheduled-occurrence.ts';
import type { RunOutcome, RunRequest, RuntimeLimits, RuntimePorts } from './scheduled-ports.ts';
import type { RunContext, WatchedResult } from './scheduled-settle.ts';
import { finishRun, loadFreshTask, watchedPipeline } from './scheduled-settle.ts';
import { keyOf, type ScheduledState } from './scheduled-state.ts';
import { messageOf } from './scheduled-util.ts';

export type { RunContext, WatchedResult } from './scheduled-settle.ts';

export function createRunController(ctx: RunContext) {
  return {
    runTask: (request: RunRequest) => runTask(ctx, request),
    runNow: (projectId: string, taskId: string) => runNow(ctx, projectId, taskId),
  };
}

async function runTask(ctx: RunContext, request: RunRequest): Promise<RunOutcome> {
  if (request.reason === 'resume') return resumeOccurrence(ctx, request);
  if (request.reason === 'scheduled') {
    if (!Number.isFinite(request.scheduledFor)) {
      return { ok: false, skipped: true, reason: 'missing-scheduled-for' };
    }
    const task = ctx.state.memoryTask(request.projectId, request.taskId);
    if (task === null) return { ok: false, skipped: true, reason: 'task-unknown' };
    if (!task.enabled) return { ok: false, skipped: true, reason: 'task-disabled' };
    return runScheduled(ctx, request, task);
  }
  return runManual(ctx, request);
}

async function runManual(ctx: RunContext, request: RunRequest): Promise<RunOutcome> {
  const task = ctx.state.memoryTask(request.projectId, request.taskId)
    ?? await loadFreshTask(ctx, request.projectId, request.taskId);
  if (task === null) return { ok: false, reason: 'task-unknown' };
  try {
    await ctx.ports.patch(request.projectId, task.id, buildManualStartPatch(ctx.ports.now()));
  } catch (error) {
    ctx.ports.log.warn(`manual start persist refused: ${String(error)}`);
  }
  const nowTs = ctx.ports.now();
  const outcome: WatchedResult = await watchedPipeline(ctx, request, task);
  return finishRun(ctx, request.projectId, task, outcome, 'manual', nowTs);
}

/** Manual run: no claim; takes the same counted slots; refuses busy. */
async function runNow(ctx: RunContext, projectId: string, taskId: string): Promise<RunOutcome> {
  const key = keyOf(projectId, taskId);
  if (ctx.state.queued.has(key) || ctx.state.running.has(key)) return { ok: false, reason: 'task-busy' };
  if (ctx.state.globalRunning >= ctx.limits.maxGlobalConcurrency
    || ctx.state.projectSlots(projectId) >= ctx.limits.maxProjectConcurrency) {
    return { ok: false, reason: 'capacity-exhausted' };
  }
  ctx.state.running.add(key);
  ctx.state.globalRunning += 1;
  ctx.state.projectRunning.set(projectId, ctx.state.projectSlots(projectId) + 1);
  try {
    return await runTask(ctx, { projectId, taskId, reason: 'manual' });
  } finally {
    ctx.state.running.delete(key);
    ctx.state.globalRunning -= 1;
    ctx.state.projectRunning.set(projectId, ctx.state.projectSlots(projectId) - 1);
    ctx.pump();
  }
}

/** Queue pump (doc 12 §C.4): starts queued runs while the global and
 * per-project slots allow, re-pumping when a run settles. */
export function createRunPump(deps: {
  state: ScheduledState;
  runTask: (request: RunRequest) => Promise<RunOutcome>;
  limits: Required<RuntimeLimits>;
  log: { error: (message: string) => void };
}): { pump: () => void; enqueue: (request: RunRequest) => boolean } {
  const { state, limits } = deps;

  function pump(): void {
    for (;;) {
      if (state.globalRunning >= limits.maxGlobalConcurrency) return;
      const next = state.queue[0];
      if (!next) return;
      if (state.projectSlots(next.projectId) >= limits.maxProjectConcurrency) return;
      state.queue.shift();
      const key = keyOf(next.projectId, next.taskId);
      state.queued.delete(key);
      state.running.add(key);
      state.globalRunning += 1;
      state.projectRunning.set(next.projectId, state.projectSlots(next.projectId) + 1);
      void deps.runTask(next)
        .catch((error) => { deps.log.error(`scheduled run fault: ${messageOf(error)}`); })
        .finally(() => {
          state.running.delete(key);
          state.globalRunning -= 1;
          state.projectRunning.set(next.projectId, state.projectSlots(next.projectId) - 1);
          pump();
        });
    }
  }

  function enqueue(request: RunRequest): boolean {
    const accepted = state.enqueue(request);
    if (accepted) pump();
    return accepted;
  }

  return { pump, enqueue };
}
