// SPDX-License-Identifier: Apache-2.0
/** P9-6b goal planting, prompt/command delivery, dispatch confirmation, and shaping. */
import type { CommandInfo } from '../../../../ui/src/lib/nnd/types.ts';
import type {
  CreatedWorktree, DispatchContext, OrchestratorDeps, RecordObject, ResolvedSelection,
  SelectionInput, SessionHarnessPorts, SessionOrchestrationResponse,
} from './session-orchestration-contract.ts';
import { GOAL_OBJECTIVE_CHAR_LIMIT } from '../goals/goal-constants.ts';
import { buildGoalPayload, getSessionGoal, type GoalPayload } from '../goals/goal-payload.ts';
import { fitObjective } from '../goals/goal-distill.ts';
import { commandArgsOf, commandNameOf, expandCommandTemplate } from '../queue/queue-expansion.ts';
import { publishControlEvent } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { asRecord, fail, messageOf, ok, textOf } from './session-orchestration-contract.ts';

export function messageIdsOf(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of messages) {
    const info = asRecord(asRecord(value)?.info) ?? asRecord(value);
    if (info?.role !== 'user') continue;
    const id = textOf(info?.id ?? '').trim();
    if (id !== '') ids.add(id);
  }
  return ids;
}

export function selectedOf(messages: readonly unknown[]): SelectionInput | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = asRecord(asRecord(messages[index])?.info) ?? asRecord(messages[index]);
    if (info === null || info.role !== 'user') continue;
    const model = asRecord(info.model);
    const agent = textOf(info.agent).trim();
    const providerID = textOf(model?.providerID).trim();
    const modelID = textOf(model?.modelID).trim();
    const variant = textOf(model?.variant).trim();
    if (providerID === '' || modelID === '' || agent === '') continue;
    return {
      model: { providerID, modelID, ...(variant === '' ? {} : { variant }) },
      agent,
    };
  }
  return null;
}

async function wasLanded(deps: OrchestratorDeps, sessionId: string, directory: string,
  baseline: ReadonlySet<string>): Promise<boolean> {
  if (deps.waitForPromptLanded !== undefined) return await deps.waitForPromptLanded(sessionId, directory, baseline);
  const messages = await deps.harness.readMessages(sessionId, directory, 100);
  return [...messageIdsOf(messages)].some((id) => !baseline.has(id));
}

async function plantGoal(deps: OrchestratorDeps, context: DispatchContext, objective: string,
  selection: ResolvedSelection): Promise<GoalPayload> {
  const fitted = await fitObjective(objective, {
    generate: deps.distill,
    preference: {
      providerID: selection.providerID, modelID: selection.modelID,
      ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    },
  });
  let objectiveFile = false;
  let objectiveFileKey: string | undefined;
  if (fitted.text.length > GOAL_OBJECTIVE_CHAR_LIMIT) {
    if (deps.objectiveStore === undefined) throw new Error('objective store is unavailable');
    objectiveFileKey = await deps.objectiveStore.write(context.sessionId, fitted.text);
    objectiveFile = true;
  }
  const goal: GoalPayload = {
    ...buildGoalPayload({
      objective: fitted.text, objectiveFile, objectiveFileKey,
      tokenBudget: context.goalTokenBudget ?? null, now: deps.now?.(),
    }),
    evaluationProviderID: selection.providerID,
    evaluationModelID: selection.modelID,
  };
  const current = getSessionGoal(await deps.harness.readSession(context.sessionId, context.directory));
  const written = await deps.harness.writeGoal(context.sessionId, context.directory, {
    goal,
    expected_id: current?.id ?? null,
    expected_revision: current?.updatedAt ?? 0,
  });
  if (!written) throw new Error('session goal was refused');
  return goal;
}

export function goalIntro(tokenBudget: number | null): string {
  const budget = tokenBudget === null ? 'No token budget is set.' : `A token budget of ${tokenBudget} tokens applies.`;
  return `A session goal has been attached to this prompt.\n\n${budget}\nThe goal loop will independently observe this turn and can auto-continue if the objective remains incomplete.`;
}

export async function dispatch(deps: OrchestratorDeps, context: DispatchContext, selection: ResolvedSelection,
  commands: readonly CommandInfo[], baseline: ReadonlySet<string>,
): Promise<{ landed: boolean; command: boolean; goalConfigured: boolean }> {
  const expanded = await promptText(deps, context.prompt, context.directory);
  const name = commandNameOf(expanded);
  const entry = name === null
    ? undefined
    : commands.find((command) => command?.name === name && command.source !== 'skill');
  const commandName = entry?.name;
  const commandTemplate = typeof entry?.template === 'string' && entry.template !== '' ? entry.template : null;
  const command: { name: string; template: string | null } | null = commandName === undefined
    ? null : { name: commandName, template: commandTemplate };
  let introducedGoal: GoalPayload | null = null;
  let goalConfigured = false;
  if (context.goal) {
    const args = command === null ? '' : commandArgsOf(expanded, command.name);
    const objective = command === null || command.template === null
      ? expanded
      : expandCommandTemplate(command.template, args);
    introducedGoal = await plantGoal(deps, context, objective, selection);
    context.goalConfigured = true;
    goalConfigured = true;
  }
  let knowledge: string | null = null;
  if (command === null && deps.knowledge !== undefined) {
    try {
      const text = await deps.knowledge.resolve(context.sessionId, context.directory);
      knowledge = text === null || text.trim() === '' ? null : text;
    } catch { knowledge = null; }
  }
  const outcome = command === null
    ? await deps.harness.sendPrompt(context.sessionId, context.directory, {
      model: { providerID: selection.providerID, modelID: selection.modelID },
      agent: selection.agent,
      // Why: no variant — the prompt route rejects per-prompt variant (nnd_variant_override_unsupported).
      parts: [
        ...(knowledge === null ? [] : [{ type: 'text', text: knowledge, synthetic: true }]),
        ...(expanded.trim() === '' ? [] : [{ type: 'text', text: expanded }]),
        ...(introducedGoal === null ? [] : [{ type: 'text', text: goalIntro(context.goalTokenBudget ?? null), synthetic: true }]),
      ],
    })
    : await deps.harness.sendCommand(context.sessionId, context.directory, {
      command: command!.name,
      arguments: commandArgsOf(expanded, command!.name),
      model: `${selection.providerID}/${selection.modelID}`,
      agent: selection.agent,
      ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    });
  if (!outcome.ok) throw new Error(`${command === null ? 'prompt' : 'command'} dispatch rejected with ${outcome.status}`);
  if (knowledge !== null && deps.knowledge !== undefined) {
    try { deps.knowledge.recordDelivered(context.sessionId, context.directory); } catch { /* delivery bookkeeping is non-fatal */ }
  }
  return {
    landed: await wasLanded(deps, context.sessionId, context.directory, baseline),
    command: command !== null,
    goalConfigured,
  };
}

export async function promptText(deps: OrchestratorDeps, prompt: string, directory: string): Promise<string> {
  if (deps.expand === undefined) return prompt;
  const expanded = await deps.expand(prompt, directory);
  return expanded.trim() === '' ? prompt : expanded;
}

export function partial(context: { error: unknown; directory: string; sessionId?: string;
  action?: 'worktree-created' | 'goal-configured' | 'fork-created' }): SessionOrchestrationResponse {
  return fail(502, messageOf(context.error), {
    partial: true,
    partialAction: context.action,
    sessionId: context.sessionId,
    directory: context.directory,
  });
}

export function responseOf(input: {
  sessionId?: string; directory: string; projectId?: string | null; title?: string;
  worktree?: CreatedWorktree | null; selection?: ResolvedSelection | null; goal?: boolean;
  goalTokenBudget?: number | null; dispatched?: boolean; command?: boolean; landed?: boolean;
  sourceSessionId?: string;
}): RecordObject {
  const body: RecordObject = {
    sessionId: input.sessionId,
    directory: input.directory,
    ...(input.projectId !== null && input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
  };
  if (input.selection !== null && input.selection !== undefined) {
    body.model = `${input.selection.providerID}/${input.selection.modelID}`;
    body.agent = input.selection.agent;
    if (input.selection.variant !== undefined) body.variant = input.selection.variant;
  }
  if (input.goal !== undefined) {
    body.goalEnabled = input.goal;
    if (input.goalTokenBudget !== undefined && input.goalTokenBudget !== null) {
      body.goalTokenBudget = input.goalTokenBudget;
    }
  }
  if (input.dispatched !== undefined) {
    body.promptDispatched = input.landed === true;
    body.dispatchedAsCommand = input.command === true;
    if (input.landed !== true) body.promptError = 'OpenCode accepted the prompt but it never appeared in the session';
  }
  return body;
}

export async function harnessSession(harness: SessionHarnessPorts, directory: string,
  title: string, route?: { providerID: string; model: string }): Promise<{ sessionId: string; title: string } | SessionOrchestrationResponse> {
  try {
    const record = await harness.createSession(directory, title, route);
    const sessionId = textOf(record.id ?? record.sessionID ?? record.sessionId).trim();
    return sessionId === ''
      ? fail(500, 'Session create did not provide an id')
      : { sessionId, title: textOf(record.title, title) };
  } catch (error) {
    return fail(502, messageOf(error));
  }
}

export async function readSessionOr(harness: SessionHarnessPorts, sessionId: string,
  directory: string): Promise<RecordObject> {
  try {
    const record = await harness.readSession(sessionId, directory);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('Unknown session');
    return record;
  } catch (error) {
    throw new Error(`${messageOf(error)} (session ${sessionId})`);
  }
}
