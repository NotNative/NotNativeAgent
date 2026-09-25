// SPDX-License-Identifier: Apache-2.0

const GOAL_STATES = new Set(['active', 'completed', 'blocked']);
const TASK_STATES = new Set(['pending', 'in_progress', 'completed', 'blocked']);

/** Security: publish only the owned work summary, never completion evidence or pending staged state. */
export function nndWorkProjection(engine) {
  if (typeof engine?.workStatus !== 'function') return null;
  let work;
  try { work = engine.workStatus(); } catch { return null; }
  if (!work || work.schema !== 'nna.conversation_work.v1'
    || !Number.isSafeInteger(work.revision) || work.revision < 0
    || !Array.isArray(work.tasks) || work.tasks.length > 64) return null;
  const goal = work.goal === null ? null : projectGoal(work.goal);
  if (work.goal !== null && !goal) return null;
  const tasks = work.tasks.map(projectTask);
  if (tasks.some((task) => task === null)) return null;
  return { revision: work.revision, goal, tasks };
}

function projectGoal(value) {
  if (!value || !boundedId(value.id) || !boundedText(value.objective, 2048)
    || !GOAL_STATES.has(value.status)) return null;
  return { id: value.id, objective: value.objective, status: value.status };
}

function projectTask(value) {
  if (!value || !/^T[1-9][0-9]{0,5}$/u.test(value.id)
    || !boundedText(value.title, 512) || !TASK_STATES.has(value.status)) return null;
  return { id: value.id, title: value.title, status: value.status };
}

function boundedId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function boundedText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
