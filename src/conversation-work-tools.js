// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function conversationWorkDefinitions(work) {
  return [statusDefinition(work), goalDefinition(work), taskAddDefinition(work), taskUpdateDefinition(work)];
}

function statusDefinition(work) {
  return definition('work.status', 'Read the current conversation goal and ordered task progress.', 'read_only', {}, [],
    async () => result(work.snapshot()));
}

function goalDefinition(work) {
  return definition('work.goal', 'Create, update, complete, or reopen the one durable goal for this conversation.', 'reversible', {
    action: { type: 'string', enum: ['set', 'complete', 'reopen'], description: 'Required goal transition.' },
    objective: { type: 'string', minLength: 1, maxLength: 2048, description: 'Required goal text when action is set; omit for complete or reopen.' },
    evidence: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required completion evidence when action is complete; omit otherwise.' },
  }, ['action'], async (args) => {
    if (args.action === 'set') return mutationResult(await work.setGoal(required(args.objective, 'objective')));
    if (args.action === 'complete') return mutationResult(await work.completeGoal(required(args.evidence, 'evidence')));
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
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'], description: 'Required next task status.' },
    detail: { type: 'string', minLength: 1, maxLength: 1024, description: 'Completion evidence for completed or blocking reason for blocked; omit for pending or in_progress.' },
  }, ['id', 'status'], async (args) => mutationResult(await work.updateTask(args.id, args.status, args.detail), { taskId: args.id }));
}

function definition(name, purpose, sideEffect, properties, requiredKeys, executor) {
  return {
    name, version: 1, purpose, sideEffect, scope: 'conversation_work', cancellation: true, timeoutMs: 2_000,
    inputSchema: { type: 'object', properties, required: requiredKeys, additionalProperties: false },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !(key in properties))
        || requiredKeys.some((key) => args[key] === undefined)) {
        throw new ContractError('tool_schema_invalid', `${name} received invalid arguments`);
      }
      for (const [key, value] of Object.entries(args)) validateProperty(name, key, value, properties[key]);
      return { args: { ...args }, resolved: { scope: 'conversation_work' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'conversation work update was cancelled');
      return executor(request.args);
    },
  };
}

function result(snapshot) {
  return { content: JSON.stringify(snapshot, null, 2), metadata: { revision: snapshot.revision, tasks: snapshot.tasks.length } };
}
function mutationResult(snapshot, options = {}) {
  const counts = Object.fromEntries(['pending', 'in_progress', 'completed', 'blocked']
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
function validateProperty(tool, key, value, schema) {
  if (schema.type === 'string' && typeof value !== 'string') invalid(tool, key);
  if (schema.enum && !schema.enum.includes(value)) invalid(tool, key);
  if (schema.minLength && value.length < schema.minLength) invalid(tool, key);
  if (schema.maxLength && value.length > schema.maxLength) invalid(tool, key);
  if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) invalid(tool, key);
}
function invalid(tool, key) { throw new ContractError('tool_schema_invalid', `${tool} received an invalid ${key}`); }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError('tool_schema_invalid', `${name} is required for this action`);
  return value;
}
