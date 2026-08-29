// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';

const TASK_STATES = new Set(['pending', 'in_progress', 'completed', 'blocked']);
const MAX_TASKS = 64;
const MAX_GOAL_TEXT = 2048;
const MAX_TASK_TITLE = 512;
const MAX_DETAIL = 1024;

export class ConversationWork {
  constructor(options = {}) {
    this.persist = options.persist ?? (async () => undefined);
    this.output = options.output ?? (async () => undefined);
    this.telemetry = options.telemetry ?? null;
    this.sessionId = options.sessionId ?? null;
    this.state = emptyState();
  }

  snapshot() { return deepFreeze(structuredClone(this.state)); }

  restore(records = []) {
    const latest = [...records].reverse().find((record) => record.type === 'work_state')?.payload;
    if (!latest) return this.snapshot();
    this.state = validateSnapshot(latest);
    return this.snapshot();
  }

  async setGoal(objective) {
    const text = boundedText(objective, 'goal objective', MAX_GOAL_TEXT);
    const now = new Date().toISOString();
    const prior = this.state.goal;
    // Setting a goal is also the explicit edit operation: preserve its stable
    // identity and creation time while replacing the objective and prior proof.
    const next = {
      ...this.state,
      revision: this.state.revision + 1,
      goal: Object.freeze({
        id: prior?.id ?? newId('goal'), objective: text, status: 'active',
        createdAt: prior?.createdAt ?? now, updatedAt: now, evidence: null,
      }),
    };
    return this.#commit(next, 'goal_set');
  }

  async completeGoal(evidence) {
    if (!this.state.goal) throw new ContractError('goal_missing', 'this conversation has no active goal');
    if (this.state.goal.status === 'completed') {
      throw new ContractError('goal_already_completed', 'the conversation goal is already completed');
    }
    const unfinished = this.state.tasks.filter((task) => task.status !== 'completed');
    if (unfinished.length > 0) throw new ContractError('goal_tasks_unfinished', `${unfinished.length} task(s) are not complete`);
    const proof = boundedText(evidence, 'goal completion evidence', MAX_DETAIL);
    const next = {
      ...this.state, revision: this.state.revision + 1,
      goal: Object.freeze({ ...this.state.goal, status: 'completed', evidence: proof, updatedAt: new Date().toISOString() }),
    };
    return this.#commit(next, 'goal_completed');
  }

  async reopenGoal() {
    if (!this.state.goal) throw new ContractError('goal_missing', 'this conversation has no goal to reopen');
    if (this.state.goal.status !== 'completed') {
      throw new ContractError('goal_not_completed', 'only a completed conversation goal can be reopened');
    }
    const next = {
      ...this.state, revision: this.state.revision + 1,
      goal: Object.freeze({ ...this.state.goal, status: 'active', evidence: null, updatedAt: new Date().toISOString() }),
    };
    return this.#commit(next, 'goal_reopened');
  }

  async clear() {
    const revision = this.state.revision + 1;
    const next = Object.freeze({ ...emptyState(), revision });
    return this.#commit(next, 'work_cleared');
  }

  async replacePlan(value) {
    if (value?.revision !== undefined && value.revision !== this.state.revision) {
      throw new ContractError(
        'work_revision_conflict',
        `work plan revision ${value.revision} is stale; current revision is ${this.state.revision}`,
      );
    }
    const plan = normalizePlan(value, this.state);
    const now = new Date().toISOString();
    let nextTaskNumber = this.state.nextTaskNumber;
    const priorTasks = new Map(this.state.tasks.map((task) => [task.id, task]));
    const tasks = plan.tasks.map((item) => {
      const prior = item.id ? priorTasks.get(item.id) : null;
      if (item.id && !prior) throw new ContractError('task_missing', `task ${item.id} does not exist; omit id when adding a new task`);
      const id = prior?.id ?? `T${nextTaskNumber++}`;
      return Object.freeze({
        id, title: item.title, status: item.status,
        evidence: item.status === 'completed' ? item.detail : null,
        blockedReason: item.status === 'blocked' ? item.detail : null,
        createdAt: prior?.createdAt ?? now, updatedAt: now,
      });
    });
    const priorGoal = this.state.goal;
    const goal = Object.freeze({
      id: priorGoal?.id ?? newId('goal'), objective: plan.objective, status: plan.goalStatus,
      evidence: plan.goalStatus === 'completed' ? plan.goalEvidence : null,
      createdAt: priorGoal?.createdAt ?? now, updatedAt: now,
    });
    const next = {
      ...this.state, revision: this.state.revision + 1, nextTaskNumber,
      goal, tasks: Object.freeze(tasks),
    };
    return this.#commit(next, 'plan_replaced');
  }

  async addTask(title) {
    if (this.state.tasks.length >= MAX_TASKS) throw new ContractError('task_capacity', `a conversation may contain at most ${MAX_TASKS} tasks`);
    const text = boundedText(title, 'task title', MAX_TASK_TITLE);
    const now = new Date().toISOString();
    const number = this.state.nextTaskNumber;
    const task = Object.freeze({
      id: `T${number}`, title: text, status: 'pending', evidence: null, blockedReason: null,
      createdAt: now, updatedAt: now,
    });
    const next = {
      ...this.state, revision: this.state.revision + 1, nextTaskNumber: number + 1,
      tasks: Object.freeze([...this.state.tasks, task]),
    };
    return this.#commit(next, 'task_added', task.id);
  }

  async updateTask(id, status, detail = null) {
    const taskId = normalizeTaskId(id);
    if (!TASK_STATES.has(status)) throw new ContractError('task_status_invalid', 'task status must be pending, in_progress, completed, or blocked');
    const index = this.state.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new ContractError('task_missing', `task ${taskId} does not exist`);
    if (status === 'in_progress' && this.state.tasks.some((task, taskIndex) => taskIndex !== index && task.status === 'in_progress')) {
      throw new ContractError('task_active_conflict', 'complete, block, or return the current in-progress task to pending first');
    }
    const evidence = status === 'completed' ? boundedText(detail, 'task completion evidence', MAX_DETAIL) : null;
    const blockedReason = status === 'blocked' ? boundedText(detail, 'task blocking reason', MAX_DETAIL) : null;
    const tasks = [...this.state.tasks];
    tasks[index] = Object.freeze({
      ...tasks[index], status, evidence, blockedReason, updatedAt: new Date().toISOString(),
    });
    const next = { ...this.state, revision: this.state.revision + 1, tasks: Object.freeze(tasks) };
    return this.#commit(next, `task_${status}`, taskId);
  }

  async #commit(next, action, taskId = null) {
    const snapshot = deepFreeze(structuredClone(next));
    await this.persist('work_state', snapshot);
    this.state = snapshot;
    this.telemetry?.record('work.state', 'succeeded', {
      action, revision: snapshot.revision, goal_status: snapshot.goal?.status ?? null,
      task_id: taskId, task_counts: taskCounts(snapshot.tasks),
    });
    await this.output({
      version: '1.0', type: 'work_status', session_id: this.sessionId,
      action, work: snapshot,
    });
    return snapshot;
  }
}

function emptyState() {
  return Object.freeze({ schema: 'nna.conversation_work.v1', revision: 0, nextTaskNumber: 1, goal: null, tasks: Object.freeze([]) });
}

function validateSnapshot(value) {
  // A snapshot is the durable state-machine boundary. Reject structural drift
  // rather than coercing it so corrupt state cannot silently acquire authority.
  if (!value || value.schema !== 'nna.conversation_work.v1' || !Number.isInteger(value.revision)
    || value.revision < 0 || !Number.isInteger(value.nextTaskNumber) || value.nextTaskNumber < 1
    || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) {
    throw new ContractError('work_state_invalid', 'durable conversation work state is invalid');
  }
  const ids = new Set();
  const tasks = value.tasks.map((task) => {
    const id = normalizeTaskId(task.id);
    if (ids.has(id) || !TASK_STATES.has(task.status)) throw new ContractError('work_state_invalid', 'durable task identity or status is invalid');
    ids.add(id);
    return Object.freeze({
      id, title: boundedText(task.title, 'task title', MAX_TASK_TITLE), status: task.status,
      evidence: optionalText(task.evidence), blockedReason: optionalText(task.blockedReason),
      createdAt: String(task.createdAt), updatedAt: String(task.updatedAt),
    });
  });
  if (value.goal !== null && (!value.goal || typeof value.goal !== 'object'
    || !['active', 'completed'].includes(value.goal.status))) {
    throw new ContractError('work_state_invalid', 'durable goal status is invalid');
  }
  const goal = value.goal === null ? null : Object.freeze({
    id: String(value.goal.id), objective: boundedText(value.goal.objective, 'goal objective', MAX_GOAL_TEXT),
    status: value.goal.status,
    evidence: optionalText(value.goal.evidence), createdAt: String(value.goal.createdAt), updatedAt: String(value.goal.updatedAt),
  });
  return Object.freeze({ ...emptyState(), revision: value.revision, nextTaskNumber: value.nextTaskNumber, goal, tasks: Object.freeze(tasks) });
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
    throw new ContractError('work_text_invalid', `${label} must be between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function optionalText(value) { return value === null || value === undefined ? null : boundedText(value, 'work detail', MAX_DETAIL); }
function normalizeTaskId(value) {
  const id = String(value ?? '').toUpperCase();
  const match = /^T([1-9][0-9]{0,5})$/u.exec(id);
  if (!match || Number(match[1]) > MAX_TASKS) throw new ContractError('task_id_invalid', `task id must be between T1 and T${MAX_TASKS}`);
  return id;
}
function taskCounts(tasks) {
  return Object.freeze(Object.fromEntries([...TASK_STATES].map((status) => [status, tasks.filter((task) => task.status === status).length])));
}

function normalizePlan(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.objective !== 'string' || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) {
    throw new ContractError('work_plan_invalid', 'work plan requires one objective and at most 64 tasks');
  }
  const objective = boundedText(value.objective, 'goal objective', MAX_GOAL_TEXT);
  const goalStatus = value.goal_status ?? 'active';
  if (!['active', 'completed'].includes(goalStatus)) throw new ContractError('work_plan_invalid', 'goal_status must be active or completed');
  const goalEvidence = goalStatus === 'completed'
    ? boundedText(value.goal_evidence, 'goal completion evidence', MAX_DETAIL) : null;
  const known = new Set(state.tasks.map((task) => task.id));
  const ids = new Set(); let inProgress = 0;
  const tasks = value.tasks.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ContractError('work_plan_invalid', 'each work-plan task must be an object');
    const id = item.id === undefined ? null : normalizeTaskId(item.id);
    if (id && (!known.has(id) || ids.has(id))) throw new ContractError('work_plan_invalid', `task id ${id} is unknown or duplicated`);
    if (id) ids.add(id);
    const title = boundedText(item.title, 'task title', MAX_TASK_TITLE);
    const status = item.status ?? 'pending';
    if (!TASK_STATES.has(status)) throw new ContractError('work_plan_invalid', 'task status is invalid');
    if (status === 'in_progress') inProgress += 1;
    const detail = ['completed', 'blocked'].includes(status)
      ? boundedText(item.detail, status === 'completed' ? 'task completion evidence' : 'task blocking reason', MAX_DETAIL)
      : null;
    return Object.freeze({ id, title, status, detail });
  });
  if (inProgress > 1) throw new ContractError('task_active_conflict', 'a work plan may contain at most one in-progress task');
  if (goalStatus === 'completed' && tasks.some((task) => task.status !== 'completed')) {
    throw new ContractError('goal_tasks_unfinished', 'a completed goal cannot contain unfinished tasks');
  }
  return Object.freeze({ objective, goalStatus, goalEvidence, tasks: Object.freeze(tasks) });
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
