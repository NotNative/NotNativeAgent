// SPDX-License-Identifier: Apache-2.0
/**
 * Occurrence claim and dispatch flow (doc 12 §C.5 + F9 at-most-once): the
 * claim CAS, the durable phase advances around the native acceptance boundary,
 * the claim-failure record, and boot-time resume-by-operation-id. A claim is
 * written BEFORE dispatch (two processes arming one slot produce one session);
 * the phase record (claimed → creating → session-created → accepted) is what
 * a restart reconciles instead of resubmitting blindly.
 */
import { computeNextRunAt } from './next-run.ts';
import {
  buildClaimFailurePatch, buildClaimPatch, buildDispatchPhasePatch,
  canAdvanceDispatch, canClaimOccurrence, dispatchOf,
  operationIdForOccurrence, ownedByLiveProcess, processAlive, stateOf,
} from './scheduled-claims.ts';
import type { PipelinePhaseHooks, RunOutcome, RunRequest } from './scheduled-ports.ts';
import type { RunContext, WatchedResult } from './scheduled-settle.ts';
import { finishRun, loadFreshTask, watchedPipeline } from './scheduled-settle.ts';
import { finiteOr, messageOf } from './scheduled-util.ts';
import { normalizeTaskForStorage, type ScheduledTask } from './task-schema.ts';

type Advanceable = 'creating' | 'session-created' | 'accepted';

/** Runs one scheduled occurrence: compute the carried slot, claim the slot in
 *  the shared config, dispatch behind the durable phases, settle. */
export async function runScheduled(
  ctx: RunContext, request: RunRequest, task: ScheduledTask,
): Promise<RunOutcome> {
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
  const operationId = operationIdForOccurrence(task.id, scheduledFor);
  const claimed = await ctx.ports.patchIf(
    request.projectId, task.id, canClaimOccurrence(scheduledFor),
    buildClaimPatch({
      scheduledFor, operationId, lastRunAt: nowTs, nextRunAt: nextAfterClaim ?? undefined, updatedAt: nowTs,
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
  const outcome = await dispatchOccurrence(ctx, request, task, scheduledFor, operationId, nowTs);
  return finishRun(ctx, request.projectId, task, outcome, 'scheduled', nowTs);
}

/** Advances the durable dispatch record; returns false only when the phase
 *  MUST be persisted before proceeding (the `creating` step, which guards the
 *  session-create boundary). A refused or failed later advance logs and
 *  proceeds: the completion patch still settles the record either way. */
export async function advanceDispatch(
  ctx: RunContext, projectId: string, taskId: string, operationId: string,
  phase: Advanceable, scheduledFor: number, sessionId?: string,
): Promise<boolean> {
  try {
    const advanced = await ctx.ports.patchIf(
      projectId, taskId, canAdvanceDispatch(operationId, phase),
      buildDispatchPhasePatch({ scheduledFor, operationId, phase, sessionId, now: ctx.ports.now() }));
    if (advanced.updated) return true;
    ctx.ports.log.warn(`scheduled dispatch phase ${phase} refused for occurrence ${operationId}`);
    return false;
  } catch (error) {
    ctx.ports.log.warn(`scheduled dispatch phase ${phase} persist failed: ${messageOf(error)}`);
    return false;
  }
}

/** Runs the pipeline with the durable phase advances around the native
 *  acceptance boundary. Phase failures decide: `creating` must persist before
 *  session create (nothing may be created behind an unsettled claim), while
 *  `session-created`/`accepted` failures only log — the completion patch owns
 *  the terminal record. */
async function dispatchOccurrence(
  ctx: RunContext, request: RunRequest, task: ScheduledTask,
  scheduledFor: number, operationId: string, nowTs: number,
): Promise<WatchedResult> {
  if (!await advanceDispatch(ctx, request.projectId, task.id, operationId, 'creating', scheduledFor)) {
    return {
      status: 'error',
      lastError: 'occurrence dispatch record was unavailable; the run was not dispatched',
    };
  }
  return await watchedPipeline(ctx, request, task,
    phaseHooks(ctx, request, task, scheduledFor, operationId, nowTs));
}

/** The pipeline's phase callbacks, bound to this occurrence's operation id.
 *  A resume that already knows its session skips the create-phase write (the
 *  record is already at `session-created`; re-writing it would fail the CAS). */
export function phaseHooks(
  ctx: RunContext, request: RunRequest, task: ScheduledTask,
  scheduledFor: number, operationId: string, nowTs: number,
): PipelinePhaseHooks {
  void nowTs;
  const resumingKnownSession = request.resumeSessionId !== undefined;
  return {
    onSessionCreated: resumingKnownSession
      ? async () => true
      : async (sessionId: string) =>
        advanceDispatch(ctx, request.projectId, task.id, operationId, 'session-created', scheduledFor, sessionId),
    onAccepted: async (sessionId: string | undefined) =>
      advanceDispatch(ctx, request.projectId, task.id, operationId, 'accepted', scheduledFor, sessionId),
  };
}

/** Boot-time reconciliation of a pending occurrence (F9 at-most-once):
 *  `claimed` → dispatch under the phase CAS (a losing peer backs off without
 *  settling); `creating` → settle as error (the session-create outcome is
 *  unknown and must never be resubmitted); `session-created` → re-dispatch to
 *  the RECORDED session with the same idempotent identity (an acceptance the
 *  crash hid resolves as NNA's duplicate 204); `accepted` → settle success
 *  from the record alone. Every settle is CAS-guarded on the phase, so a live
 *  peer that progressed past this phase is never clobbered. */
export async function resumeOccurrence(ctx: RunContext, request: RunRequest): Promise<RunOutcome> {
  const task = ctx.state.memoryTask(request.projectId, request.taskId)
    ?? await loadFreshTask(ctx, request.projectId, request.taskId);
  if (task === null) return { ok: false, skipped: true, reason: 'task-unknown' };
  const dispatch = task.state.dispatch ?? null;
  if (dispatch === null || !Number.isFinite(request.scheduledFor)) {
    return { ok: false, skipped: true, reason: 'resume-record-absent' };
  }
  const scheduledFor = request.scheduledFor as number;
  const operationId = dispatch.operationId;
  const nowTs = ctx.ports.now();
  const startedAt = dispatch.updatedAt !== 0 ? dispatch.updatedAt : nowTs;
  // A record owned by a live process is an in-flight run elsewhere: never
  // double-drive it; the owning process settles its own occurrence.
  if (ownedByLiveProcess(dispatch, processAlive)) {
    return { ok: false, skipped: true, reason: 'resume-owned-elsewhere' };
  }
  if (dispatch.phase === 'creating') {
    return settleResumed(ctx, request, task, operationId, 'creating', startedAt, {
      status: 'error',
      lastError: `session create outcome unknown after restart (operation ${operationId})`,
    });
  }
  if (dispatch.phase === 'claimed') {
    // The durable stop guard outranks resumption: a task the user disabled
    // after its claim never reaches the harness.
    if (task.enabled === false) {
      return settleResumed(ctx, request, task, operationId, 'claimed', startedAt, {
        status: 'error', lastError: 'user stop before dispatch (occurrence not submitted)',
      });
    }
    return runResumedDispatch(ctx, request, task, scheduledFor, operationId, nowTs, startedAt);
  }
  if (dispatch.phase === 'accepted') {
    return settleResumed(ctx, request, task, operationId, 'accepted', startedAt, {
      status: 'success', sessionID: dispatch.sessionId,
    });
  }
  if (dispatch.phase === 'session-created') {
    if (dispatch.sessionId === undefined || dispatch.sessionId === '') {
      return settleResumed(ctx, request, task, operationId, 'session-created', startedAt, {
        status: 'error', lastError: `occurrence session identity missing (operation ${operationId})`,
      });
    }
    return runResumedDispatch(ctx, request, task, scheduledFor, operationId, nowTs, startedAt, dispatch.sessionId);
  }
  return { ok: false, skipped: true, reason: 'resume-record-unknown' };
}

/** CAS into `creating` (only from `claimed` — a `session-created` record must
 *  never regress) before the resumed pipeline; ownership is checked first so
 *  a losing peer never settles the winner's record. */
async function runResumedDispatch(
  ctx: RunContext, request: RunRequest, task: ScheduledTask,
  scheduledFor: number, operationId: string, nowTs: number, startedAt: number,
  resumeSessionId?: string,
): Promise<RunOutcome> {
  if (resumeSessionId === undefined) {
    const owned = await advanceDispatch(ctx, request.projectId, task.id, operationId, 'creating', scheduledFor);
    if (!owned) return { ok: false, skipped: true, reason: 'resume-raced' };
  }
  const resumeRequest: RunRequest = { ...request, ...(resumeSessionId !== undefined ? { resumeSessionId } : {}) };
  const outcome = await watchedPipeline(ctx, resumeRequest, task,
    phaseHooks(ctx, resumeRequest, task, scheduledFor, operationId, nowTs));
  return finishRun(ctx, request.projectId, task, outcome, 'scheduled', startedAt);
}

/** CAS-guarded completion for a resumed occurrence: the settle only lands
 *  while the persisted dispatch record still shows the expected phase (a peer
 *  that progressed makes the settle a no-op skip). */
async function settleResumed(
  ctx: RunContext, request: RunRequest, task: ScheduledTask, operationId: string,
  phase: 'claimed' | 'creating' | 'accepted' | 'session-created', startedAt: number,
  outcome: WatchedResult,
): Promise<RunOutcome> {
  const guard = (raw: Record<string, unknown>): boolean => {
    const record = dispatchOf(raw);
    return record !== null && record.operationId === operationId && record.phase === phase;
  };
  return finishRun(ctx, request.projectId, task, outcome, 'scheduled', startedAt, guard);
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
