// SPDX-License-Identifier: Apache-2.0
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

const TASK_STATUS = Object.freeze({ completed: 'completed', inProgress: 'in_progress', blocked: 'blocked', pending: 'pending' });
const TASK_MARKERS = Object.freeze({
  [TASK_STATUS.pending]: '[ ]', [TASK_STATUS.inProgress]: '[>]', [TASK_STATUS.completed]: '[x]', [TASK_STATUS.blocked]: '[!]',
});
const TASK_PRIORITY = Object.freeze({
  [TASK_STATUS.inProgress]: 0, [TASK_STATUS.blocked]: 1, [TASK_STATUS.pending]: 2, [TASK_STATUS.completed]: 3,
});
const LARGE_VIEW_HEIGHT = 36;
const MEDIUM_VIEW_HEIGHT = 28;
const SMALL_VIEW_HEIGHT = 20;

export function workSummaryRows(work, width, height, collapsed = false) {
  if (!work?.goal && !work?.tasks?.length) return [];
  if (height < 10) return [];
  const tasks = work.tasks ?? [];
  const completed = tasks.filter((task) => task.status === TASK_STATUS.completed).length;
  const progress = `${completed}/${tasks.length}`;
  if (collapsed) return [compactRow(collapsedSummary(work.goal, tasks), 'work:compact', width)];

  const rows = [row(`▾ ${goalSummary(work.goal, progress)}`, goalKind(work.goal), width)];
  const limit = visibleTaskLimit(height);
  const visible = visibleTasks(tasks, limit);
  for (const task of visible) rows.push(row(`  ${taskMarker(task.status)} ${task.id}  ${task.title}`, `work:task:${task.status}`, width));
  const hidden = tasks.length - visible.length;
  rows.push(row(`  ${hidden > 0 ? `… ${hidden} more · ` : ''}/plan manage`, 'work:hint', width));
  return rows;
}

function collapsedSummary(goal, tasks) {
  const active = tasks.find((task) => task.status === TASK_STATUS.inProgress)
    ?? tasks.find((task) => task.status === TASK_STATUS.blocked)
    ?? tasks.find((task) => task.status === TASK_STATUS.pending);
  const label = goal ? `GOAL ${goalStatusLabel(goal)}` : 'TASKS';
  if (active) {
    const position = tasks.indexOf(active) + 1;
    const state = activeTaskLabel(active.status);
    return `▸ ${label} · ${state} ${position}/${tasks.length} · ${active.title}`;
  }
  if (tasks.length > 0) return `▸ ${label} · ${tasks.length}/${tasks.length} complete · ${goal?.objective ?? 'All tasks complete'}`;
  return `▸ ${label} · ${goal?.objective ?? 'No tasks'}`;
}

function goalSummary(goal, progress) {
  if (!goal) return `WORK · ${progress} tasks complete`;
  return `GOAL ${goalStatusLabel(goal)} · ${goal.objective} · ${progress} tasks complete`;
}

function goalStatusLabel(goal) {
  return ['active', 'completed', 'blocked'].includes(goal?.status) ? goal.status.toUpperCase() : 'UNKNOWN';
}

function goalKind(goal) {
  if (goal?.status === 'completed') return 'work:goal:completed';
  if (goal?.status === 'blocked') return 'work:goal:blocked';
  return 'work:goal:active';
}

function visibleTasks(tasks, limit) {
  if (tasks.length <= limit) return tasks;
  const selected = tasks.map((task, index) => ({ task, index }))
    .sort((left, right) => (TASK_PRIORITY[left.task.status] ?? 4) - (TASK_PRIORITY[right.task.status] ?? 4) || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index);
  return selected.map(({ task }) => task);
}

function taskMarker(status) {
  return TASK_MARKERS[status] ?? '[?]';
}

function visibleTaskLimit(height) {
  if (height >= LARGE_VIEW_HEIGHT) return 8;
  if (height >= MEDIUM_VIEW_HEIGHT) return 5;
  if (height >= SMALL_VIEW_HEIGHT) return 3;
  return 1;
}

function activeTaskLabel(status) {
  if (status === TASK_STATUS.inProgress) return 'task';
  if (status === TASK_STATUS.blocked) return 'blocked';
  return 'next';
}

function row(text, kind, width) {
  return Object.freeze({ text: truncateTerminal(text, width), kind });
}

function compactRow(text, kind, width) {
  const clipped = displayWidth(text) > width
    ? `${truncateTerminal(text, Math.max(0, width - 1))}…`
    : text;
  return Object.freeze({ text: clipped, kind });
}
