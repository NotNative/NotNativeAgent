// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function projectConversationWork(snapshot) {
  requireConversationWorkSnapshot(snapshot);
  const tasks = snapshot.tasks.map((task) => Object.freeze({
    id: task.id,
    title: task.title,
    status: task.status,
    ...(['completed', 'blocked'].includes(task.status)
      ? { detail: task.status === 'completed' ? task.evidence : task.blockedReason }
      : {}),
  }));
  if (snapshot.goal === null) {
    return Object.freeze({ revision: snapshot.revision, objective: null, goal_status: null, tasks: Object.freeze(tasks) });
  }
  // Why: provider-visible work state must use the exact work_plan input shape so
  // injected context and work_status cannot teach conflicting field names.
  return Object.freeze({
    revision: snapshot.revision,
    objective: snapshot.goal.objective,
    goal_status: snapshot.goal.status,
    ...(snapshot.goal.status === 'completed' ? { goal_evidence: snapshot.goal.evidence } : {}),
    ...(snapshot.goal.status === 'blocked' ? { goal_blocked_reason: snapshot.goal.blockedReason } : {}),
    tasks: Object.freeze(tasks),
  });
}

export function requireConversationWorkSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.tasks)
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || snapshot.tasks.length > 64 || snapshot.tasks.some((task) => !validTask(task))
    || new Set(snapshot.tasks.map((task) => task.id)).size !== snapshot.tasks.length
    || snapshot.tasks.filter((task) => task.status === 'in_progress').length > 1
    || !validGoal(snapshot.goal, snapshot.tasks)) {
    throw new ContractError('work_snapshot_invalid', 'conversation work returned an invalid snapshot');
  }
}

function validTask(task) {
  return task && typeof task === 'object' && !Array.isArray(task)
    && typeof task.id === 'string' && /^T[1-9][0-9]{0,5}$/u.test(task.id)
    && validText(task.title, 512)
    && ['pending', 'in_progress', 'completed', 'blocked'].includes(task.status)
    && (task.status !== 'completed' || validText(task.evidence, 1024))
    && (task.status !== 'blocked' || validText(task.blockedReason, 1024));
}

function validGoal(goal, tasks) {
  if (goal === null) return true;
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)
    || !validText(goal.objective, 2048)
    || !['active', 'completed', 'blocked'].includes(goal.status)) return false;
  if (goal.status === 'completed') {
    return validText(goal.evidence, 1024) && tasks.every((task) => task.status === 'completed');
  }
  if (goal.status === 'blocked') {
    return validText(goal.blockedReason, 1024)
      && tasks.every((task) => ['completed', 'blocked'].includes(task.status));
  }
  return true;
}

function validText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
