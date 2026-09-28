// SPDX-License-Identifier: Apache-2.0
/** P9-6b request parsing and scope validation. */
import { statSync } from 'node:fs';
import type {
  CreateInput, OrchestratorDeps, RecordObject, RunInput, ScopeInput, SelectionInput,
  SessionOrchestrationResponse, WorktreeRequest,
} from './session-orchestration-contract.ts';
import { BUDGET_MIN, BUDGET_MAX, asRecord, fail, textOf } from './session-orchestration-contract.ts';

export function parseWorktree(value: unknown): WorktreeRequest | string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const name = value.trim();
    if (name === '') return 'worktree must be a non-empty string or object';
    return { mode: 'new', name, branchName: name };
  }
  const record = asRecord(value);
  if (record === null) return 'worktree must be a JSON object when supplied';
  const mode = textOf(record.mode).trim() || 'new';
  if (mode !== 'new') return 'worktree.mode must be "new"';
  const name = textOf(record.name).trim() || textOf(record.branchName).trim();
  if (name === '') return 'worktree.name is required';
  const requested: WorktreeRequest = {
    branchName: textOf(record.branchName).trim() || name,
    mode,
    name,
  };
  if (record.startRef !== undefined) {
    const startRef = textOf(record.startRef).trim();
    if (startRef === '') return 'worktree.startRef cannot be blank';
    requested.startRef = startRef;
  }
  if (record.setUpstream !== undefined) {
    if (typeof record.setUpstream !== 'boolean') return 'worktree.setUpstream must be boolean';
    if (record.setUpstream) requested.setUpstream = true;
  }
  return requested;
}

const budgetError = `goalTokenBudget must be an integer from ${BUDGET_MIN} through ${BUDGET_MAX}`;

function budgetOf(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < BUDGET_MIN || value > BUDGET_MAX) return null;
  return value;
}

function selectionFromBody(body: RecordObject): SelectionInput {
  const selection = asRecord(body.selection);
  const model = selection?.model ?? body.model;
  const agent = selection?.agent ?? body.agent;
  const variant = selection?.variant ?? body.variant;
  return {
    ...(model !== undefined ? { model: model as SelectionInput['model'] } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

export function parseCreateBody(body: RecordObject): CreateInput | string {
  if (body.setUpstream !== undefined && typeof body.setUpstream !== 'boolean') {
    return 'setUpstream must be boolean';
  }
  const worktree = parseWorktree(body.worktree);
  if (typeof worktree === 'string') return worktree;
  if (worktree !== null && body.setUpstream === true) worktree.setUpstream = true;
  const goalTokenBudget = budgetOf(body.goalTokenBudget);
  if (goalTokenBudget === null) return budgetError;
  const goal = body.goal !== undefined ? typeof body.goal === 'boolean' ? body.goal : true : false;
  const title = textOf(body.title).trim();
  const prompt = textOf(body.prompt);
  if (goal && prompt.trim() === '') return 'goal may only be armed with a prompt';
  if (goalTokenBudget !== undefined && goal === false) return 'goalTokenBudget requires goal';
  return {
    scope: { directory: textOf(body.directory).trim() || undefined, projectId: textOf(body.projectID ?? body.projectId).trim() || undefined },
    ...(title !== '' ? { title } : {}),
    ...(prompt.trim() !== '' ? { prompt } : {}),
    selection: selectionFromBody(body),
    ...(goal ? { goal } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    ...(worktree !== null ? { worktree } : {}),
  };
}

export function parseRunBody(body: RecordObject): RunInput | string {
  const goalTokenBudget = budgetOf(body.goalTokenBudget);
  if (goalTokenBudget === null) return budgetError;
  const prompt = textOf(body.prompt ?? body.text).trim();
  if (prompt === '') return 'prompt is required';
  const goal = body.goal !== undefined ? typeof body.goal === 'boolean' ? body.goal : true : false;
  if (goalTokenBudget !== undefined && goal === false) return 'goalTokenBudget requires goal';
  const boundary = textOf(body.forkMessageId ?? body.messageID).trim();
  return {
    scope: { directory: textOf(body.directory).trim() || undefined, projectId: textOf(body.projectID ?? body.projectId).trim() || undefined },
    prompt, selection: selectionFromBody(body),
    ...(goal ? { goal } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    ...(boundary !== '' ? { boundary } : {}),
  };
}

export function safeDirectory(directory: string): boolean {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

export async function resolveScope(deps: OrchestratorDeps, scope: ScopeInput): Promise<string | SessionOrchestrationResponse> {
  if (scope.directory !== undefined) {
    if (scope.projectId !== undefined) return fail(400, 'Provide either directory or projectID, not both');
    if (deps.directoryExists !== undefined && !await deps.directoryExists(scope.directory)) {
      return fail(400, 'directory must be a real directory');
    }
    return scope.directory;
  }
  if (scope.projectId === undefined) return fail(400, 'directory or projectID is required');
  if (deps.projectDirectory === undefined) return fail(400, 'project directory resolution is unavailable');
  const directory = await deps.projectDirectory(scope.projectId);
  if (directory === null || directory === '') return fail(404, `Unknown project '${scope.projectId}'`);
  if (deps.directoryExists !== undefined && !await deps.directoryExists(directory)) {
    return fail(400, 'directory must be a real directory');
  }
  return directory;
}
