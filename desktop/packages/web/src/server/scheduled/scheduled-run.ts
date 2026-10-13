// SPDX-License-Identifier: Apache-2.0
/**
 * Run control (doc 12 §C.5/C.6/C.7): the claim protocol around the harness
 * pipeline, the watchdog race, and completion persistence. A scheduled run
 * claims its occurrence in the shared config BEFORE dispatch, so two
 * processes arming the same slot produce exactly one session; a refuser
 * adopts the winner's task and re-arms from the winner's persisted slot. A
 * timed-out run is recorded as error while its session keeps running; a
 * completion persist failure gets exactly ONE best-effort retry before the
 * controller falls back to the in-memory task for the terminal state.
 */
import { computeNextRunAt } from './next-run.ts';
import {
  buildClaimPatch, buildClaimFailurePatch, buildCompletionPatch, buildManualStartPatch,
  canClaimOccurrence, stateOf,
} from './scheduled-claims.ts';
import type {
  PipelineOutcome, RunOutcome, RunRequest, RuntimeLimits, RuntimePorts,
} from './scheduled-ports.ts';
import { keyOf, type ScheduledState } from './scheduled-state.ts';
import { finiteOr, messageOf, optionalFinite } from './scheduled-util.ts';
import { normalizeTaskForStorage, type ScheduledTask } from './task-schema.ts';

interface WatchedResult { sessionID?: string; status: 'success' | 'error'; lastError?: string }

export interface RunContext {
  ports: RuntimePorts;
  state: ScheduledState;
  limits: Required<RuntimeLimits>;
  pump: () => void;
}

export function createRunController(ctx: RunContext) {
  return {
    runTask: (request: RunRequest) => runTask(ctx, request),
    runNow: (projectId: string, taskId: string) => runNow(ctx, projectId, taskId),
  };
}

async function runTask(ctx: RunContext, request: RunRequest): Promise<RunOutcome> {
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

async function runScheduled(ctx: RunContext, request: RunRequest, task: ScheduledTask): Promise<RunOutcome> {
  const scheduledFor = request.scheduledFor as number;
  const nowTs = ctx.ports.now();
  const nextAfterClaim = computeNextRunAt(task.schedule, task.enabled,
    Math.max(nowTs, scheduledFor + 1));
  try {
    return await claimAndDispatch(ctx, request, task, scheduledFor, nextAfterClaim, nowTs);
  } catch (error) {
    await recordClaimFailure(ctx, request.projectId, task, scheduledFor, error);
    return { ok: false, skipped: true, reason: 'claim-failed' };
  }
}

async function claimAndDispatch(
  ctx: RunContext, request: RunRequest, task: ScheduledTask,
  scheduledFor: number, nextAfterClaim: number | null, nowTs: number,
): Promise<RunOutcome> {
  const claimed = await ctx.ports.patchIf(
    request.projectId, task.id, canClaimOccurrence(scheduledFor),
    buildClaimPatch({
      scheduledFor, lastRunAt: nowTs, nextRunAt: nextAfterClaim ?? undefined, updatedAt: nowTs,
    }));
  if (!claimed.updated) {
    const winner = adoptKnown(ctx, claimed.task);
    const theirs = winner ?? task;
    if (winner !== null) ctx.state.remember(request.projectId, winner);
    const theirsNext = stateOf(claimed.task ?? {}).nextRunAt;
    if (typeof theirsNext === 'number' && Number.isFinite(theirsNext)) {
      ctx.state.scheduleFutureRun(request.projectId, theirs, theirsNext);
    }
    return { ok: false, skipped: true, reason: 'occurrence-claimed', task: theirs };
  }
  const outcome = await watchedPipeline(ctx, request, task);
  return finishRun(ctx, request.projectId, task, outcome, 'scheduled', nowTs);
}

/** Normalizes the sibling's raw record for adoption; a record a normalize
 * cannot survive (or rejects outright) adopts nothing and the caller falls
 * back to our own snapshot. The refused path must never throw out into the
 * claim-failure handler, which would clobber the winner's advanced slot. */
function adoptKnown(ctx: RunContext, raw: Record<string, unknown> | null): ScheduledTask | null {
  if (raw === null) return null;
  try {
    const outcome = normalizeTaskForStorage(raw, ctx.ports.normalizeOptions);
    return outcome.ok ? outcome.task : null;
  } catch {
    return null;
  }
}

async function recordClaimFailure(
  ctx: RunContext, projectId: string, task: ScheduledTask, scheduledFor: number, error: unknown,
): Promise<void> {
  try {
    await ctx.ports.patchIf(projectId, task.id, canClaimOccurrence(scheduledFor),
      buildClaimFailurePatch(error, ctx.ports.now()));
  } catch (recordError) {
    ctx.ports.log.warn(`scheduled claim failure record refused: ${String(recordError)}`);
  }
  await rearmNext(ctx, projectId, task);
}

/** Recomputes and persists the next slot after a failed claim, then arms. */
async function rearmNext(ctx: RunContext, projectId: string, task: ScheduledTask): Promise<void> {
  const nextAt = computeNextRunAt(task.schedule, task.enabled, ctx.ports.now());
  if (Number.isFinite(nextAt)) {
    try {
      await ctx.ports.patch(projectId, task.id, { nextRunAt: nextAt, updatedAt: ctx.ports.now() });
    } catch (patchError) {
      ctx.ports.log.warn(`scheduled re-arm persist refused: ${String(patchError)}`);
    }
  }
  ctx.state.scheduleFutureRun(projectId, task, finiteOr(nextAt, -Infinity));
}

/** Races the pipeline: a timeout records an error and discards the result
 * (the session it may have created is NOT aborted). Every pipeline failure -
 * rejection, SYNCHRONOUS throw, or a resolved value of an unexpected shape -
 * maps to a run error below the claim, because the occurrence is already
 * claimed here: nothing after the claim may escape into the claim-failure
 * path and leave the claimed run without a completion record. */
async function watchedPipeline(ctx: RunContext, request: RunRequest, task: ScheduledTask): Promise<WatchedResult> {
  // The async wrapper defuses a synchronous runPipeline throw, and the single
  // catch maps every failure mode; `background` therefore never rejects and
  // the race's own catch can only mean the guard fired.
  const background = (async (): Promise<WatchedResult> => {
    const outcome = (await ctx.ports.runPipeline(request, task)) as PipelineOutcome | null | undefined;
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
  const outcome = await watchedPipeline(ctx, request, task);
  return finishRun(ctx, request.projectId, task, outcome, 'manual', nowTs);
}

async function loadFreshTask(ctx: RunContext, projectId: string, taskId: string): Promise<ScheduledTask | null> {
  const load = await ctx.ports.load(projectId);
  const found = load.tasks.find((task) => task.id === taskId) ?? null;
  if (found !== null) ctx.state.remember(projectId, found);
  return found;
}

async function finishRun(
  ctx: RunContext, projectId: string, memory: ScheduledTask,
  outcome: WatchedResult, reason: 'scheduled' | 'manual', startedAt: number,
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
  const persistError = await persistCompletion(ctx, projectId, memory, latest, patch, outcome, finishedAt);
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
