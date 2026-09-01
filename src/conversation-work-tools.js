// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { projectConversationWork, requireConversationWorkSnapshot } from './conversation-work-projection.js';
import { normalizeArgumentAliases } from './tools/argument-normalization.js';

const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked']);
const GOAL_STATUSES = Object.freeze(['active', 'completed', 'blocked']);

export function conversationWorkDefinitions(work) {
  return [planDefinition(work), statusDefinition(work), goalDefinition(work), taskAddDefinition(work), taskUpdateDefinition(work)];
}

function planDefinition(work) {
  return definition('work.plan', 'Replace the durable conversation goal and complete ordered task snapshot in one call. Output from work.plan or work.status can be passed back unchanged. Preserve returned task ids when updating existing tasks; omit id only for a new task.', 'reversible', {
    revision: { type: 'integer', minimum: 0, description: 'Optional revision returned by work.plan or work.status. A stale revision is rejected without changing work.' },
    objective: { type: 'string', minLength: 1, maxLength: 2048, description: 'Required current goal objective.' },
    goal_status: { type: 'string', enum: GOAL_STATUSES, description: 'Goal status. Defaults to active.' },
    goal_evidence: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required only when goal_status is completed.' },
    goal_blocked_reason: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required only when goal_status is blocked.' },
    tasks: {
      type: 'array', maxItems: 64, description: 'Required complete ordered task list; omitted prior tasks are removed.',
      items: {
        type: 'object', additionalProperties: false, required: ['title'], properties: {
          id: { type: 'string', pattern: '^T[1-9][0-9]{0,5}$', description: 'Existing task id returned by work.plan; omit for a new task.' },
          title: { type: 'string', minLength: 1, maxLength: 512, description: 'Concise task title.' },
          status: { type: 'string', enum: TASK_STATUSES, description: 'Defaults to pending.' },
          detail: { type: 'string', minLength: 1, maxLength: 1024, description: 'Completion evidence or blocking reason.' },
        },
      },
    },
  }, ['objective', 'tasks'], async (args) => planResult(await work.replacePlan(args)), normalizeWorkPlanArgs);
}

function statusDefinition(work) {
  return definition('work.status', 'Read the current conversation goal and ordered task progress. When a plan exists, the output can be passed unchanged to work.plan.', 'read_only', {}, [],
    async () => planResult(work.snapshot()));
}

function goalDefinition(work) {
  return definition('work.goal', 'Create, update, complete, block, or reopen the one durable goal for this conversation.', 'reversible', {
    action: { type: 'string', enum: ['set', 'complete', 'block', 'reopen'], description: 'Required goal transition.' },
    objective: { type: 'string', minLength: 1, maxLength: 2048, description: 'Required goal text when action is set; omit otherwise.' },
    evidence: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required completion evidence when action is complete; omit otherwise.' },
    reason: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required blocking reason when action is block; omit otherwise.' },
  }, ['action'], async (args) => {
    if (args.action === 'set') return mutationResult(await work.setGoal(required(args.objective, 'objective')));
    if (args.action === 'complete') return mutationResult(await work.completeGoal(required(args.evidence, 'evidence')));
    if (args.action === 'block') return mutationResult(await work.blockGoal(required(args.reason, 'reason')));
    return mutationResult(await work.reopenGoal());
  });
}

function taskAddDefinition(work) {
  return definition('work.task_add', 'Add one ordered pending task to the durable conversation work list.', 'reversible', {
    title: { type: 'string', minLength: 1, maxLength: 512, description: 'Required concise description of the new pending task.' },
  }, ['title'], async (args) => mutationResult(await work.addTask(args.title), { task: 'last' }));
}

function taskUpdateDefinition(work) {
  return definition('work.task_update', 'Move one durable conversation task to pending, in_progress, completed, or blocked. Completion requires evidence and blocking requires a reason.', 'reversible', {
    id: { type: 'string', pattern: '^T[1-9][0-9]{0,5}$', description: 'Required task id such as T1, returned by work.status or work.task_add.' },
    status: { type: 'string', enum: TASK_STATUSES, description: 'Required next task status.' },
    detail: { type: 'string', minLength: 1, maxLength: 1024, description: 'Concise completion evidence for completed or blocking reason for blocked, limited to 1,024 characters; omit for pending or in_progress.' },
  }, ['id', 'status'], async (args) => mutationResult(await work.updateTask(args.id, args.status, args.detail), { taskId: args.id }));
}

function definition(name, purpose, sideEffect, properties, requiredKeys, executor, normalizeArgs = null) {
  const patterns = Object.fromEntries(Object.entries(properties)
    .filter(([, schema]) => typeof schema.pattern === 'string')
    .map(([key, schema]) => [key, new RegExp(schema.pattern, 'u')]));
  return {
    name, version: 1, purpose, sideEffect, scope: 'conversation_work', cancellation: true, timeoutMs: 2_000,
    inputSchema: { type: 'object', properties, required: requiredKeys, additionalProperties: false },
    ...(normalizeArgs ? { normalizeArgs } : {}),
    validate: async (rawArgs) => {
      const args = normalizeArgs ? normalizeArgs(rawArgs) : rawArgs;
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !(key in properties))
        || requiredKeys.some((key) => args[key] === undefined)) {
        throw new ContractError('tool_schema_invalid', `${name} received invalid arguments`);
      }
      for (const [key, value] of Object.entries(args)) validateProperty(name, key, value, properties[key], patterns[key]);
      return { args: { ...args }, resolved: { scope: 'conversation_work' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'conversation work update was cancelled');
      return executor(request.args);
    },
  };
}

function planResult(snapshot) {
  const plan = projectConversationWork(snapshot);
  return { content: JSON.stringify(plan, null, 2), metadata: { revision: snapshot.revision, tasks: snapshot.tasks.length } };
}
function mutationResult(snapshot, options = {}) {
  requireConversationWorkSnapshot(snapshot);
  const counts = Object.fromEntries(TASK_STATUSES
    .map((status) => [status, snapshot.tasks.filter((task) => task.status === status).length]));
  const task = options.task === 'last' ? snapshot.tasks.at(-1)
    : snapshot.tasks.find((item) => item.id === String(options.taskId ?? '').toUpperCase());
  const summary = {
    revision: snapshot.revision, goal_status: snapshot.goal?.status ?? null,
    task: task ? { id: task.id, status: task.status, title: task.title } : undefined,
    task_counts: counts,
  };
  return { content: JSON.stringify(summary), metadata: { revision: snapshot.revision, tasks: snapshot.tasks.length } };
}
function validateProperty(tool, key, value, schema, pattern) {
  if (schema.type === 'string' && typeof value !== 'string') invalid(tool, key);
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) invalid(tool, key);
  if (schema.minimum !== undefined && value < schema.minimum) invalid(tool, key);
  if (schema.enum && !schema.enum.includes(value)) invalid(tool, key);
  if (schema.minLength && value.length < schema.minLength) invalid(tool, key);
  if (schema.maxLength && value.length > schema.maxLength) invalid(tool, key);
  if (pattern && !pattern.test(value)) invalid(tool, key);
  if (schema.type === 'array' && !Array.isArray(value)) invalid(tool, key);
}
function invalid(tool, key) { throw new ContractError('tool_schema_invalid', `${tool} received an invalid ${key}`); }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError('tool_schema_invalid', `${name} is required for this action`);
  return value;
}

function normalizeWorkPlanArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tasks)) return value;
  return {
    ...value,
    tasks: value.tasks.map((task) => normalizeArgumentAliases(task, {
      detail: ['evidence', 'blockedReason', 'blocked_reason'],
    })),
  };
}
