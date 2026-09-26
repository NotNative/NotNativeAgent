// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled run pipeline (doc 12 C.6): the harness-facing adapter injected
 * behind the runtime's `runPipeline` port. One call creates the session
 * (title = task name + the slot's wall clock in the schedule zone), emits the
 * running event, plants the goal for goal-mode tasks, and dispatches either
 * the matched slash command (POST /session/:id/command) or the plain prompt
 * (prompt_async parts in the C.6 order: knowledge, prompt, goal intro).
 * Auxiliary failures (knowledge lookup, emission, goal planting) degrade with
 * a warning; only a failed session create or a rejected dispatch is a run
 * error (the runtime records it).
 */
import { GOAL_OBJECTIVE_CHAR_LIMIT, TOKEN_BUDGET_MAX } from '../goals/goal-constants.ts';
import { GOAL_NAMESPACE, buildGoalPayload, getSessionGoal, type GoalPayload } from '../goals/goal-payload.ts';
import { ObjectiveStore } from '../goals/objective-store.ts';
import { fitObjective, type DistillPort } from '../goals/goal-distill.ts';
import { commandEntryOf } from '../queue/queue-dispatch.ts';
import type { ProjectKnowledgeProvider } from '../queue/queue-hooks.ts';
import { commandArgsOf, commandNameOf, expandCommandTemplate } from '../queue/queue-expansion.ts';
import type { PipelineOutcome, RunRequest } from './scheduled-ports.ts';
import { messageOf } from './scheduled-util.ts';
import type { ScheduledTask } from './task-schema.ts';

/** Name clip before the wall-clock stamp (doc C.6 step 1: name trimmed at 120). */
export const SCHEDULED_TITLE_MAX = 120;

/** Harness seams the pipeline needs; production impls live in nna-scheduled-ports. */
export interface ScheduledHarnessPorts {
  createSession: (directory: string, title: string) => Promise<unknown>;
  sendPrompt: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
  sendCommand: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
  listCommands: (directory: string) => Promise<unknown>;
  readSession: (sessionId: string, directory: string) => Promise<unknown>;
  writeGoal: (sessionId: string, directory: string, body: {
    goal: GoalPayload; expected_id: string | null; expected_revision: number;
  }) => Promise<boolean>;
  resolveDirectory: (projectId: string) => Promise<string | null>;
}

export interface ScheduledPipelineDeps {
  harness: ScheduledHarnessPorts;
  knowledge: ProjectKnowledgeProvider;
  emitRunning: (event: { projectId: string; taskId: string; ranAt: number; sessionID: string }) => void;
  waitForReady: () => Promise<boolean>;
  expandPrompt: (text: string, directory: string) => Promise<string>;
  objectiveStore: Pick<ObjectiveStore, 'write'>;
  /** B.6.3 small-model seam; absent (P-11 not wired yet) → excerpt fallback. */
  distill?: DistillPort;
  log: { warn: (message: string) => void; error: (message: string) => void };
  now: () => number;
}

interface DispatchContext {
  request: RunRequest;
  task: ScheduledTask;
  sessionId: string;
  directory: string;
  startedAt: number;
}

/** B.6.1 goal-mode intro, verbatim; the budget sentence rides before the
 *  closing tag when a server-created goal carries one. */
const GOAL_INTRO_BODY = 'Goal mode is active for this session. The user message above defines the goal objective. Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The created record's id: doc C.6 abstracts `sessionID`; harness records
 *  (mock and NNA) carry `id`. Blank/missing means a dispatch-less run error. */
function sessionOf(created: unknown): string {
  const record = asRecord(created);
  const direct = typeof record?.sessionID === 'string' ? record.sessionID : '';
  const inner = typeof record?.id === 'string' ? record.id : '';
  return direct !== '' ? direct : inner;
}

/** `yyyy-LL-dd HH:mm` in the slot's zone (en-GB parts, h23). */
function titleStamp(at: number, zone: string): string {
  const table = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${String(table.year)}-${String(table.month)}-${String(table.day)} ${String(table.hour)}:${String(table.minute)}`;
}

/** C.6 step 1 title: clipped task name + the slot's wall clock. */
export function runTitle(task: ScheduledTask, at: number): string {
  const name = task.name.trim().slice(0, SCHEDULED_TITLE_MAX);
  return `${name} ${titleStamp(at, task.schedule.timezone)}`;
}

/** B.6.1 intro part text; `null` budget omits the budget sentence. A budget
 *  a goal payload cannot carry (parseTokenBudget rejects < 1 / > max) is
 *  treated the same, so the intro never claims a budget the goal lacks. */
export function goalIntro(tokenBudget: number | null): string {
  const budget = tokenBudget !== null && Number.isInteger(tokenBudget)
    && tokenBudget >= 1 && tokenBudget <= TOKEN_BUDGET_MAX
    ? ` A token budget of ${tokenBudget} tokens applies to this goal.` : '';
  return `<system-reminder>\n${GOAL_INTRO_BODY}${budget}\n</system-reminder>`;
}

/** NNA seeds fresh sessions at revision 0; the goal namespace may be absent
 *  on a brand-new record. A present goal with no revision stays an error. */
function revisionOf(record: unknown, current: GoalPayload | null): number {
  const metadata = asRecord(asRecord(record)?.metadata);
  const namespace = asRecord(metadata?.[GOAL_NAMESPACE]);
  const revision = namespace?.goalRevision;
  if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) return revision;
  if (current === null) return 0;
  throw new Error('NNA session goal revision is unavailable; refresh before writing');
}

/** C.6 step 5 emission never fails the run. */
function emitRunning(deps: ScheduledPipelineDeps, ctx: DispatchContext): void {
  try {
    deps.emitRunning({
      projectId: ctx.request.projectId, taskId: ctx.request.taskId,
      ranAt: ctx.startedAt, sessionID: ctx.sessionId,
    });
  } catch (error) {
    deps.log.warn(`scheduled running event refused: ${messageOf(error)}`);
  }
}

/** Knowledge lookup failure sends without it (C.6 step 9.1). A blank or
 *  whitespace-resolved text counts as "none": nothing was delivered, so
 *  `recordDelivered` must stay silent (same resolver rule as the queue). */
async function resolveKnowledge(
  deps: ScheduledPipelineDeps, sessionId: string, directory: string,
): Promise<string | null> {
  try {
    const text = await deps.knowledge.resolve(sessionId, directory);
    return typeof text === 'string' && text.trim() !== '' ? text : null;
  } catch (error) {
    deps.log.warn(`scheduled knowledge lookup failed: ${messageOf(error)}`);
    return null;
  }
}

function recordKnowledge(deps: ScheduledPipelineDeps, ctx: DispatchContext, sessionId: string): void {
  try {
    deps.knowledge.recordDelivered(sessionId, ctx.directory);
  } catch (error) {
    deps.log.warn(`scheduled knowledge delivery record failed: ${messageOf(error)}`);
  }
}

/** A6.7 (auto-accept runtime) is not wired in NND yet: the toggle cannot
 *  auto-approve the first permission this slice (registered C.6 step 6 gap). */
function noteAutoAccept(deps: ScheduledPipelineDeps, task: ScheduledTask, sessionId: string): void {
  if (task.execution.permissionAutoAccept === true) {
    deps.log.warn(`scheduled auto-accept not wired; session ${sessionId} prompts for permissions normally`);
  }
}

/** B.7 goal planting: objective file first over the clamp, then the payload
 *  write with fresh-revision tolerance. Failure is warn-only (C.6 step 8). */
async function plantGoal(
  deps: ScheduledPipelineDeps, ctx: DispatchContext, sessionId: string, raw: string,
): Promise<boolean> {
  const execution = ctx.task.execution;
  // B.6.3: the goal objective is the FITTED text (distilled when the port
  // is bound; excerpt fallback over the limit); the full raw prompt still
  // rides the chat message, so the trim marker's promise stays honest.
  const fitted = await fitObjective(raw, {
    generate: deps.distill,
    preference: { providerID: execution.providerID, modelID: execution.modelID },
  });
  const objective = fitted.text;
  let objectiveFile = false;
  let objectiveFileKey: string | undefined;
  const long = objective.length > GOAL_OBJECTIVE_CHAR_LIMIT;
  if (long) {
    try {
      objectiveFileKey = await deps.objectiveStore.write(sessionId, objective);
      objectiveFile = true;
    } catch (error) {
      // the inline fallback is a real B.7 degradation: always logged, file
      // and input failures alike (with the session for log attribution)
      deps.log.warn(`objective file write failed for session ${sessionId}: ${messageOf(error)}`);
    }
  }
  const goal: GoalPayload = {
    ...buildGoalPayload({
      objective, objectiveFile, objectiveFileKey,
      tokenBudget: execution.goalTokenBudget ?? null, now: ctx.startedAt,
    }),
    evaluationProviderID: execution.providerID,
    evaluationModelID: execution.modelID,
  };
  const record = await deps.harness.readSession(sessionId, ctx.directory);
  const current = getSessionGoal(record);
  const body = {
    goal, expected_id: current?.id ?? null, expected_revision: revisionOf(record, current),
  };
  const written = await deps.harness.writeGoal(sessionId, ctx.directory, body);
  if (!written) deps.log.warn(`goal planting refused for session ${sessionId}; dispatching without goal mode`);
  return written;
}

function promptBody(task: ScheduledTask, parts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    model: { providerID: task.execution.providerID, modelID: task.execution.modelID },
    ...(task.execution.agent !== undefined ? { agent: task.execution.agent } : {}),
    ...(task.execution.variant !== undefined ? { variant: task.execution.variant } : {}),
    parts,
  };
}

function commandBody(task: ScheduledTask, name: string, args: string): Record<string, unknown> {
  return {
    command: name, arguments: args,
    model: `${task.execution.providerID}/${task.execution.modelID}`,
    ...(task.execution.agent !== undefined ? { agent: task.execution.agent } : {}),
    ...(task.execution.variant !== undefined ? { variant: task.execution.variant } : {}),
  };
}

/** C.6 step 9 plain prompt route: parts in order, recordDelivered after ok. */
async function dispatchPromptRoute(deps: ScheduledPipelineDeps, ctx: DispatchContext): Promise<void> {
  const text = await deps.expandPrompt(ctx.task.execution.prompt, ctx.directory);
  let intro: string | null = null;
  if (ctx.task.execution.goalEnabled === true) {
    const planted = await plantGoal(deps, ctx, ctx.sessionId, text);
    // a refused goal write dispatches WITHOUT the intro (no goal mode to claim)
    intro = planted ? goalIntro(ctx.task.execution.goalTokenBudget ?? null) : null;
  }
  const knowledge = await resolveKnowledge(deps, ctx.sessionId, ctx.directory);
  const parts: Array<Record<string, unknown>> = [];
  if (knowledge !== null) parts.push({ type: 'text', text: knowledge, synthetic: true });
  if (text.trim() !== '') parts.push({ type: 'text', text });
  if (intro !== null) parts.push({ type: 'text', text: intro, synthetic: true });
  const outcome = await deps.harness.sendPrompt(ctx.sessionId, ctx.directory, promptBody(ctx.task, parts));
  if (!outcome.ok) throw new Error(`prompt dispatch rejected with ${outcome.status}`);
  if (knowledge !== null) recordKnowledge(deps, ctx, ctx.sessionId);
}

/** C.6 step 9 command route: expanded-template objective for the goal
 *  (template-less commands keep the raw invocation), no synthetic parts. */
async function dispatchCommandRoute(
  deps: ScheduledPipelineDeps, ctx: DispatchContext, name: string, template: string | null,
): Promise<void> {
  const args = commandArgsOf(ctx.task.execution.prompt, name);
  if (ctx.task.execution.goalEnabled === true) {
    const objective = template !== null ? expandCommandTemplate(template, args) : ctx.task.execution.prompt;
    await plantGoal(deps, ctx, ctx.sessionId, objective);
  }
  const outcome = await deps.harness.sendCommand(ctx.sessionId, ctx.directory, commandBody(ctx.task, name, args));
  if (!outcome.ok) throw new Error(`command dispatch rejected with ${outcome.status}`);
}

/** C.6 step 7 slash resolution: a catalog hit executes; a miss, a read
 *  failure, or a skill-named entry degrades to the plain prompt route. */
async function slashRoute(
  deps: ScheduledPipelineDeps, directory: string, prompt: string,
): Promise<{ name: string; template: string | null } | null> {
  const name = commandNameOf(prompt);
  if (name === null) return null;
  try {
    const entry = commandEntryOf(await deps.harness.listCommands(directory), name);
    if (entry === null || entry.source === 'skill') return null;
    return { name, template: typeof entry.template === 'string' && entry.template !== '' ? entry.template : null };
  } catch (error) {
    deps.log.warn(`scheduled command catalog refused: ${messageOf(error)}`);
    return null;
  }
}

async function runScheduledPipeline(deps: ScheduledPipelineDeps, request: RunRequest, task: ScheduledTask): Promise<PipelineOutcome> {
  const startedAt = deps.now();
  if (!await deps.waitForReady()) {
    deps.log.warn('harness not ready within the scheduled poll window; proceeding');
  }
  const directory = await deps.harness.resolveDirectory(request.projectId);
  if (directory === null) throw new Error(`project ${request.projectId} has no harness worktree`);
  const sessionId = sessionOf(await deps.harness.createSession(directory, runTitle(task, startedAt)));
  if (sessionId === '') throw new Error('harness session create returned no session id');
  const ctx: DispatchContext = { request, task, sessionId, directory, startedAt };
  emitRunning(deps, ctx);
  noteAutoAccept(deps, task, sessionId);
  const route = task.execution.prompt.startsWith('/') ? await slashRoute(deps, directory, task.execution.prompt) : null;
  if (route !== null) await dispatchCommandRoute(deps, ctx, route.name, route.template);
  else await dispatchPromptRoute(deps, ctx);
  const finishedAt = deps.now();
  return {
    sessionID: sessionId,
    durationMs: finishedAt - startedAt, reason: request.reason, startedAt, finishedAt,
  };
}

/** Builds the C.6 pipeline port handed to the scheduled runtime. */
export function createScheduledRunPipeline(deps: ScheduledPipelineDeps) {
  return (request: RunRequest, task: ScheduledTask): Promise<PipelineOutcome> =>
    runScheduledPipeline(deps, request, task);
}
