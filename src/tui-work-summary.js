// SPDX-License-Identifier: Apache-2.0
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

export function workSummaryRows(work, width, height, collapsed = false) {
  if (!work?.goal && !work?.tasks?.length) return [];
  if (height < 10) return [];
  const tasks = work.tasks ?? [];
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const progress = `${completed}/${tasks.length}`;
  if (collapsed) return [compactRow(collapsedSummary(work.goal, tasks), 'work:compact', width)];

  const rows = [row(`▾ ${goalSummary(work.goal, progress)}`, goalKind(work.goal), width)];
  const limit = height >= 36 ? 8 : height >= 28 ? 5 : height >= 20 ? 3 : 1;
  const visible = visibleTasks(tasks, limit);
  for (const task of visible) rows.push(row(`  ${taskMarker(task.status)} ${task.id}  ${task.title}`, `work:task:${task.status}`, width));
  const hidden = tasks.length - visible.length;
  rows.push(row(`  ${hidden > 0 ? `… ${hidden} more · ` : ''}/plan manage`, 'work:hint', width));
  return rows;
}

function collapsedSummary(goal, tasks) {
  const active = tasks.find((task) => task.status === 'in_progress')
    ?? tasks.find((task) => task.status === 'blocked')
    ?? tasks.find((task) => task.status === 'pending');
  const label = goal ? `GOAL ${goal.status.toUpperCase()}` : 'TASKS';
  if (active) {
    const position = tasks.indexOf(active) + 1;
    const state = active.status === 'in_progress' ? 'task' : active.status === 'blocked' ? 'blocked' : 'next';
    return `▸ ${label} · ${state} ${position}/${tasks.length} · ${active.title}`;
  }
  if (tasks.length > 0) return `▸ ${label} · ${tasks.length}/${tasks.length} complete · ${goal?.objective ?? 'All tasks complete'}`;
  return `▸ ${label} · ${goal?.objective ?? 'No tasks'}`;
}

function goalSummary(goal, progress) {
  if (!goal) return `WORK · ${progress} tasks complete`;
  return `GOAL ${goal.status.toUpperCase()} · ${goal.objective} · ${progress} tasks complete`;
}

function goalKind(goal) {
  return goal?.status === 'completed' ? 'work:goal:completed' : 'work:goal:active';
}

function visibleTasks(tasks, limit) {
  if (tasks.length <= limit) return tasks;
  const priority = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
  const selected = tasks.map((task, index) => ({ task, index }))
    .sort((left, right) => priority[left.task.status] - priority[right.task.status] || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index);
  return selected.map(({ task }) => task);
}

function taskMarker(status) {
  return ({ pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' })[status] ?? '[?]';
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
