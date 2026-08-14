// SPDX-License-Identifier: Apache-2.0
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

export function workSummaryRows(work, width, height) {
  if (!work?.goal && !work?.tasks?.length) return [];
  if (height < 10) return [];
  const tasks = work.tasks ?? [];
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const progress = `${completed}/${tasks.length}`;
  const compact = width < 60 || height < 24;
  if (compact) return [compactRow(compactSummary(work.goal, tasks, progress), 'work:compact', width)];

  const rows = [row(goalSummary(work.goal, progress), goalKind(work.goal), width)];
  const limit = height >= 36 ? 8 : height >= 28 ? 5 : 3;
  const visible = visibleTasks(tasks, limit);
  for (const task of visible) rows.push(row(`  ${taskMarker(task.status)} ${task.id}  ${task.title}`, `work:task:${task.status}`, width));
  const hidden = tasks.length - visible.length;
  rows.push(row(`  ${hidden > 0 ? `… ${hidden} more · ` : ''}/plan manage`, 'work:hint', width));
  return rows;
}

function compactSummary(goal, tasks, progress) {
  const active = tasks.find((task) => task.status === 'in_progress')
    ?? tasks.find((task) => task.status === 'blocked')
    ?? tasks.find((task) => task.status === 'pending');
  const goalText = goal ? `Goal ${goal.status} · ${goal.objective}` : 'Tasks';
  const taskText = active ? ` · ${active.id} ${active.title}` : '';
  return `${goalText} · ${progress}${taskText}`;
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
  const suffix = ' · /plan';
  const bodyWidth = Math.max(0, width - displayWidth(suffix));
  const clipped = displayWidth(text) > bodyWidth && bodyWidth > 0
    ? `${truncateTerminal(text, Math.max(0, bodyWidth - 1))}…`
    : truncateTerminal(text, bodyWidth);
  return Object.freeze({ text: `${clipped}${suffix}`, kind });
}
