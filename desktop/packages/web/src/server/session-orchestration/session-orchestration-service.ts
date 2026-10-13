// SPDX-License-Identifier: Apache-2.0
/** P9-6b create/send/fork/archive orchestration workflow. */
import type {
  CreateInput, CreatedWorktree, DispatchContext, OrchestratorDeps, RecordObject, ResolvedSelection,
  RunInput, SelectionInput, SessionOrchestrationResponse,
} from './session-orchestration-contract.ts';
import { WORKTREE_WAIT_MS, asRecord, fail, messageOf, ok, textOf } from './session-orchestration-contract.ts';
import { resolveScope } from './session-orchestration-input.ts';
import { emptyHarnessFixture, loadHarness, resolveSelection } from './session-orchestration-selection.ts';
import {
  dispatch, harnessSession, messageIdsOf, partial, readSessionOr, responseOf, selectedOf,
} from './session-orchestration-dispatch.ts';
import { WorktreeCreatedError } from './session-worktree.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { publishControlEvent } from '../lib/bus.ts';

function defaultEmit(event: RecordObject): void {
  try { publishControlEvent({ type: CONTROL_EVENTS.sessionCreated, payload: event }); } catch { /* fanout is non-fatal */ }
}

async function prepareWorktree(deps: OrchestratorDeps, sourceDirectory: string,
  requested: CreateInput['worktree']): Promise<{ directory: string; worktree: CreatedWorktree | null } | SessionOrchestrationResponse> {
  if (requested === undefined) return { directory: sourceDirectory, worktree: null };
  if (deps.createWorktree === undefined) return fail(500, 'worktree creation is unavailable');
  try {
    const worktree = await deps.createWorktree(sourceDirectory, requested);
    const directory = worktree.directory;
    const ready = deps.waitForWorktree === undefined || await deps.waitForWorktree(directory, WORKTREE_WAIT_MS);
    if (!ready) {
      return fail(500, 'Timed out waiting for the worktree bootstrap', {
        partial: true, partialAction: 'worktree-created', directory,
      });
    }
    return { directory, worktree };
  } catch (error) {
    if (error instanceof WorktreeCreatedError) {
      return fail(500, messageOf(error), {
        partial: true,
        partialAction: 'worktree-created',
        directory: error.created.directory,
      });
    }
    return fail(500, messageOf(error));
  }
}

export async function createSession(deps: OrchestratorDeps, input: CreateInput): Promise<SessionOrchestrationResponse> {
  const directoryResult = await resolveScope(deps, input.scope);
  if (typeof directoryResult !== 'string') return directoryResult;
  const prompt = input.prompt;
  const fixture = prompt === undefined
    ? emptyHarnessFixture()
    : await loadHarness(deps, directoryResult);
  const selection = prompt === undefined
    ? { providerID: '', modelID: '', agent: '' }
    : await resolveSelection(deps, directoryResult, input.selection ?? {}, fixture.providers, fixture.agents, fixture.config);
  if ('ok' in selection) return selection;
  const prepared = await prepareWorktree(deps, directoryResult, input.worktree);
  if ('ok' in prepared) return prepared as SessionOrchestrationResponse;
  const directory = prepared.directory;
  const session = await harnessSession(deps.harness, directory, input.title ?? 'New session',
    prompt === undefined || selection.providerID === '' || selection.modelID === ''
      ? undefined : { providerID: selection.providerID, model: selection.modelID });
  if ('ok' in session) return session as SessionOrchestrationResponse;
  if (prompt === undefined) {
    const body = responseOf({
      sessionId: session.sessionId, directory, projectId: input.scope.projectId ?? null,
      title: session.title, worktree: prepared.worktree,
    });
    (deps.emit ?? defaultEmit)({ ...body, createdAt: deps.now?.() ?? Date.now() });
    return ok(body);
  }
  const baseline = messageIdsOf(await deps.harness.readMessages(session.sessionId, directory, 100));
  const context: DispatchContext = {
    sessionId: session.sessionId, directory, prompt,
    goal: input.goal === true, goalTokenBudget: input.goalTokenBudget,
  };
  try {
    const dispatched = await dispatch(deps, context, selection, fixture.commands, baseline);
    const body = responseOf({
      sessionId: context.sessionId, directory, projectId: input.scope.projectId ?? null,
      title: session.title, worktree: prepared.worktree, selection, goal: context.goal,
      goalTokenBudget: context.goalTokenBudget ?? null, dispatched: true,
      command: dispatched.command, landed: dispatched.landed,
    });
    (deps.emit ?? defaultEmit)({ ...body, createdAt: deps.now?.() ?? Date.now() });
    return ok(body);
  } catch (error) {
    return partial({
      error,
      sessionId: context.sessionId,
      directory,
      action: context.goalConfigured ? 'goal-configured' : undefined,
    });
  }
}

export async function sendSession(deps: OrchestratorDeps, sessionId: string, input: RunInput,
  fork: boolean = false): Promise<SessionOrchestrationResponse> {
  const directoryResult = await resolveScope(deps, input.scope);
  if (typeof directoryResult !== 'string') return directoryResult;
  let sourceRecord: RecordObject;
  try {
    sourceRecord = await readSessionOr(deps.harness, sessionId, directoryResult);
  } catch (error) {
    return fail(404, messageOf(error), { sessionId, directory: directoryResult });
  }
  let messages: unknown[];
  try {
    messages = await deps.harness.readMessages(sessionId, directoryResult, 100);
  } catch (error) {
    return fail(502, messageOf(error), { sessionId, directory: directoryResult });
  }
  const selection = await selectionForRun(
    deps, sessionId, directoryResult, input.selection, fork ? sourceRecord : null, messages,
  );
  if ('ok' in selection) return selection;
  if (!fork) {
    return await dispatchExisting(deps, sessionId, directoryResult, input, selection, messages, null);
  }
  let forked: RecordObject;
  try {
    forked = await deps.harness.forkSession(sessionId, directoryResult, {
      ...(input.boundary === undefined ? {} : { messageID: input.boundary }),
      ...(selection.providerID === '' || selection.modelID === '' ? {}
        : { providerID: selection.providerID, model: selection.modelID }),
    });
  } catch (error) {
    return fail(502, messageOf(error), { sessionId, directory: directoryResult });
  }
  const forkId = textOf(forked.id ?? forked.sessionID ?? forked.sessionId).trim();
  if (forkId === '') return fail(502, 'harness fork did not provide a session id', { sessionId, directory: directoryResult });
  const forkDirectory = textOf(forked.directory, directoryResult);
  return await dispatchExisting(deps, forkId, forkDirectory, input, selection, messages, sessionId);
}

async function selectionForRun(
  deps: OrchestratorDeps, sessionId: string, directory: string, selection: SelectionInput,
  source?: RecordObject | null, messages: readonly unknown[] = [],
): Promise<ResolvedSelection | SessionOrchestrationResponse> {
  void sessionId; void source;
  const fixtures = await loadHarness(deps, directory);
  const requested = selection.agent === undefined && selection.model === undefined && selection.variant === undefined
    ? (selectedOf(messages) ?? {})
    : selection;
  return await resolveSelection(deps, directory, requested, fixtures.providers, fixtures.agents, fixtures.config);
}

async function dispatchExisting(deps: OrchestratorDeps, sessionId: string, directory: string,
  input: RunInput, selection: ResolvedSelection, sourceMessages: readonly unknown[],
sourceSessionId: string | null): Promise<SessionOrchestrationResponse> {
  const context: DispatchContext = {
    sessionId, directory, prompt: input.prompt,
    goal: input.goal === true, goalTokenBudget: input.goalTokenBudget,
  };
  let baseline = messageIdsOf(sourceMessages);
  try {
    if (sourceSessionId !== null) {
      baseline = new Set([...baseline, ...messageIdsOf(await deps.harness.readMessages(sessionId, directory, 100))]);
    }
    const fixture = await loadHarness(deps, directory);
    const dispatched = await dispatch(deps, context, selection, fixture.commands, baseline);
    const body = responseOf({
      sessionId, directory, projectId: input.scope.projectId ?? null, selection,
      goal: context.goal, goalTokenBudget: context.goalTokenBudget ?? null,
      dispatched: true, command: dispatched.command, landed: dispatched.landed,
      ...(sourceSessionId !== null ? { sourceSessionId } : {}),
    });
    (deps.emit ?? defaultEmit)({ ...body, createdAt: deps.now?.() ?? Date.now() });
    return ok(body);
  } catch (error) {
    return partial({
      error, sessionId, directory,
      action: sourceSessionId !== null ? 'fork-created'
        : context.goalConfigured ? 'goal-configured' : undefined,
    });
  }
}

export async function archiveSessionIds(deps: OrchestratorDeps, sessionIds: unknown): Promise<SessionOrchestrationResponse> {
  if (!Array.isArray(sessionIds)) return fail(400, 'sessionIds must be an array of strings');
  const requested = sessionIds.map((value) => textOf(value).trim());
  if (requested.some((value) => value === '')) return fail(400, 'sessionIds must be an array of non-empty strings');
  if (requested.length > 500) return fail(400, 'sessionIds supports at most 500 ids per batch');
  const archivedIds: string[] = [];
  const failedIds: string[] = [];
  const archivedAt = deps.now?.() ?? Date.now();
  for (const id of requested) {
    let directory = '';
    try {
      const record = await deps.harness.readSession(id, '');
      const recordValue = asRecord(record);
      directory = textOf(recordValue?.directory).trim();
      if (directory === '') throw new Error('session directory is unavailable');
      if (await deps.harness.archiveSession(id, directory, archivedAt)) archivedIds.push(id);
      else throw new Error('archive rejected');
    } catch {
      failedIds.push(id);
    }
  }
  return ok({ archivedIds, failedIds });
}
