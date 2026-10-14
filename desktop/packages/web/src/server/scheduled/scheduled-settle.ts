// SPDX-License-Identifier: Apache-2.0
/**
 * Shared run-settlement plumbing (doc 12 §C.6/C.7): the pipeline watchdog
 * race, completion persistence (plain and phase-guarded), terminal memory
 * marking, and the fresh-task load. Split from run control so the occurrence
 * claim/resume flow and the controller both settle runs through ONE bounded
 * path — a completion persist still gets exactly ONE best-effort retry before
 * the controller falls back to the in-memory task for the terminal state.
 */
import { computeNextRunAt } from './next-run.ts';
import { buildCompletionPatch } from './scheduled-claims.ts';
import type {
  PipelineOutcome, PipelinePhaseHooks, RunOutcome, RunRequest, RuntimeLimits, RuntimePorts,
} from './scheduled-ports.ts';
import type { ScheduledState } from './scheduled-state.ts';
import { finiteOr, messageOf, optionalFinite } from './scheduled-util.ts';
import type { ScheduledTask } from './task-schema.ts';

export interface WatchedResult { sessionID?: string; status: 'success' | 'error'; lastError?: string }

export interface RunContext {
  ports: RuntimePorts;
  state: ScheduledState;
  limits: Required<RuntimeLimits>;
  pump: () => void;
}

/** Races the pipeline: a timeout records an error and discards the result
 * (the session it may have created is NOT aborted). Every pipeline failure -
 * rejection, SYNCHRONOUS throw, or a resolved value of an unexpected shape -
 * maps to a run error below the claim, because the occurrence is already
 * claimed when this runs: nothing after the claim may escape into the
 * claim-failure path and leave the claimed run without a completion record. */
export async function watchedPipeline(
  ctx: RunContext, request: RunRequest, task: ScheduledTask, phases?: PipelinePhaseHooks,
): Promise<WatchedResult> {
  // The async wrapper defines a synchronous runPipeline throw, and the single
  // catch maps every failure mode; `background` therefore never rejects and
  // the race's own catch can only mean the guard fired.
  const background = (async (): Promise<WatchedResult> => {
    const outcome = (await ctx.ports.runPipeline(request, task, phases)) as PipelineOutcome | null | undefined;
    return { sessionID: outcome?.sessionID, status: 'success' };
  })().catch((error: unknown): WatchedResult => ({ status: 'error', lastError: messageOf(error) }));
  let guardHandle: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((resolve, reject) => {
    guardHandle = setTimeout(() => reject(new Error('scheduled task run timed out')), ctx.limits.maxRunDurationMs);
  });
  try {
    return await Promise.race([background, guard]);
  } catch {
    void background; // settles on its own via its own catch; its result is discarded
    return { status: 'error', lastError: 'scheduled task run timed out' };
  } finally {
    if (guardHandle !== null) clearTimeout(guardHandle);
  }
}

/** Reads the store's freshest copy of a task, remembering it in the runtime. */
export async function loadFreshTask(
  ctx: RunContext, projectId: string, taskId: string,
): Promise<ScheduledTask | null> {
  const load = await ctx.ports.load(projectId);
  const found = load.tasks.find((task) => task.id === taskId) ?? null;
  if (found !== null) ctx.state.remember(projectId, found);
  return found;
}

/** Settles a completed run: persist terminal state, re-arm the next slot,
 * fan the event out. `completionGuard` (resume paths) narrows the completion
 * CAS to the expected dispatch phase so a progressed peer's record wins. */
export async function finishRun(
  ctx: RunContext, projectId: string, memory: ScheduledTask,
  outcome: WatchedResult, reason: 'scheduled' | 'manual', startedAt: number,
  completionGuard?: (raw: Record<string, unknown>) => boolean,
): Promise<RunOutcome> {
  const finishedAt = ctx.ports.now();
  if (memory.schedule?.kind === 'once' && reason === 'scheduled' && memory.enabled) {
    await consumeOnceSafely(ctx, projectId, memory);
  }
  const latest = await safeLatest(ctx, projectId, memory);
  const nextAt = computeNextRunAt(latest.schedule, latest.enabled, finishedAt);
  const patch = buildCompletionPatch({
    status: outcome.status, lastError: outcome.lastError, sessionID: outcome.sessionID,
    durationMs: finishedAt - startedAt, nextRunAt: optionalFinite(nextAt), updatedAt: finishedAt,
  });
  let persistError: string | undefined;
  if (completionGuard !== undefined) {
    const guarded = await persistGuardedCompletion(
      ctx, projectId, memory, latest, patch, outcome, finishedAt, completionGuard);
    if (guarded === 'refused') {
      // A resumed occurrence whose record advanced past the expected phase:
      // the live peer owns the outcome, so neither the re-arm nor the emit runs here.
      return { ok: false, skipped: true, reason: 'resume-record-advanced' };
    }
    persistError = guarded;
  } else {
    persistError = await persistCompletion(ctx, projectId, memory, latest, patch, outcome, finishedAt);
  }
  const armed = optionalFinite(nextAt);
  if (persistError === undefined && latest.enabled && armed !== undefined) {
    ctx.state.scheduleFutureRun(projectId, latest, armed);
  }
  // Event fan-out never fails the run (the same wrap doc 12 gives the
  // in-pipeline C.6 emission): a throwing emitter must not misclassify an
  // already-completed, already-claimed run as a claim failure.
  try {
    ctx.ports.emit({
      projectId, taskId: memory.id, ranAt: finishedAt, status: outcome.status, sessionID: outcome.sessionID,
    });
  } catch (error) {
    ctx.ports.log.warn(`task run event refused: ${messageOf(error)}`);
  }
  return {
    ok: outcome.status === 'success', status: outcome.status, sessionID: outcome.sessionID,
    task: ctx.state.memoryTask(projectId, memory.id) ?? latest, persistError,
  };
}

async function consumeOnceSafely(ctx: RunContext, projectId: string, task: ScheduledTask): Promise<void> {
  try {
    await ctx.ports.consumeOnce(projectId, task);
  } catch (error) {
    ctx.ports.log.warn(`one-time consumption failed: ${String(error)}`);
  }
}

async function safeLatest(ctx: RunContext, projectId: string, fallback: ScheduledTask): Promise<ScheduledTask> {
  try {
    return await ctx.ports.readLatest(projectId, fallback.id) ?? fallback;
  } catch (error) {
    ctx.ports.log.warn(`latest task read refused: ${String(error)}`);
    return fallback;
  }
}

/** Exactly ONE retry of the same completion patch. */
async function persistCompletion(
  ctx: RunContext, projectId: string, memory: ScheduledTask, latest: ScheduledTask,
  patch: Record<string, unknown>, outcome: WatchedResult, finishedAt: number,
): Promise<string | undefined> {
  try {
    await ctx.ports.patch(projectId, memory.id, patch);
    return undefined;
  } catch {
    try {
      await ctx.ports.patch(projectId, memory.id, patch);
      return undefined;
    } catch (retryError) {
      ctx.ports.log.warn(`completion persist refused twice: ${String(retryError)}`);
      markTerminal(ctx, projectId, memory.id, outcome, finishedAt);
      rearmFromMemory(ctx, projectId, latest);
      return messageOf(retryError);
    }
  }
}

/** Completion under the phase guard: the same single-retry semantics, but the
 *  patch only lands while the persisted dispatch record still matches the
 *  guard (predicate runs on the RAW stored record inside the config lock). A
 *  refused guard answers 'refused' — the record belongs to a progressed peer,
 *  so the terminal state, re-arm and emit all stay that peer's responsibility. */
async function persistGuardedCompletion(
  ctx: RunContext, projectId: string, memory: ScheduledTask, latest: ScheduledTask,
  patch: Record<string, unknown>, outcome: WatchedResult, finishedAt: number,
  guard: (raw: Record<string, unknown>) => boolean,
): Promise<'refused' | string | undefined> {
  try {
    const attempt = await ctx.ports.patchIf(projectId, memory.id, guard, patch);
    if (attempt.updated) return undefined;
    if (attempt.task === null) {
      // The task vanished from the config; fall back to the unguarded settle.
      return persistCompletion(ctx, projectId, memory, latest, patch, outcome, finishedAt);
    }
    return 'refused';
  } catch (error) {
    try {
      const retry = await ctx.ports.patchIf(projectId, memory.id, guard, patch);
      if (retry.updated) return undefined;
      if (retry.task === null) {
        return persistCompletion(ctx, projectId, memory, latest, patch, outcome, finishedAt);
      }
      return 'refused';
    } catch (retryError) {
      ctx.ports.log.warn(`completion persist refused twice: ${String(retryError)}`);
      markTerminal(ctx, projectId, memory.id, outcome, finishedAt);
      rearmFromMemory(ctx, projectId, latest);
      return messageOf(retryError);
    }
  }
}

function markTerminal(
  ctx: RunContext, projectId: string, taskId: string,
  outcome: WatchedResult, at: number,
): void {
  const known = ctx.state.memoryTask(projectId, taskId);
  if (!known) return;
  const nextState = { ...known.state, lastStatus: outcome.status, updatedAt: at } as ScheduledTask['state'];
  if (outcome.status === 'success' && outcome.sessionID !== undefined) nextState.lastSessionId = outcome.sessionID;
  if (outcome.status === 'error') nextState.lastError = outcome.lastError ?? 'scheduled task run failed';
  ctx.state.remember(projectId, { ...known, state: nextState });
}

function rearmFromMemory(ctx: RunContext, projectId: string, task: ScheduledTask): void {
  const nextAt = computeNextRunAt(task.schedule, task.enabled, ctx.ports.now());
  ctx.state.scheduleFutureRun(projectId, task, finiteOr(nextAt, -Infinity));
}
