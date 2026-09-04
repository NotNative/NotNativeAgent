// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function projectConversationWork(snapshot) {
  requireConversationWorkSnapshot(snapshot);
  if (snapshot.goal === null) {
    return Object.freeze({ revision: snapshot.revision, objective: null, goal_status: null, tasks: Object.freeze([]) });
  }
  const tasks = snapshot.tasks.map((task) => Object.freeze({
    id: task.id,
    title: task.title,
    status: task.status,
    ...(['completed', 'blocked'].includes(task.status)
      ? { detail: task.status === 'completed' ? task.evidence : task.blockedReason }
      : {}),
  }));
  // Why: provider-visible work state must use the exact work.plan input shape so
  // injected context and work.status cannot teach conflicting field names.
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
    || (snapshot.goal !== null && (!snapshot.goal || typeof snapshot.goal.objective !== 'string'
      || !['active', 'completed', 'blocked'].includes(snapshot.goal.status)))
    || snapshot.tasks.some((task) => !task || typeof task.id !== 'string' || typeof task.title !== 'string'
      || !['pending', 'in_progress', 'completed', 'blocked'].includes(task.status))) {
    throw new ContractError('work_snapshot_invalid', 'conversation work returned an invalid snapshot');
  }
}
