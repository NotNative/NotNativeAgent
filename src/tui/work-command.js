// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { planOverlay, taskOverlay } from './overlays.js';

const WORK_NOTICE_CATEGORY = 'work';
const TASK_PREFIX = 'task:';
const ACTION_PREFIX = 'action:';
const TASK_STATUS = Object.freeze({
  start: 'in_progress',
  pending: 'pending',
  complete: 'completed',
  block: 'blocked',
});

export async function handleWorkCommand(name, argument, workspace) {
  const engine = workspace.activeEngine();
  const value = argument.trim();
  if (name === '/plan' || name === '/tasks') {
    if (value) throw new ContractError('work_command_invalid', `${name} does not accept arguments; use /goal or /task to update progress`);
    return openPlan(workspace);
  }
  if (name === '/goal') {
    if (!value) return openPlan(workspace);
    if (value === 'reopen') await engine.reopenGoal();
    else if (value.startsWith('complete ')) await engine.completeGoal(value.slice(9).trim());
    else if (value === 'complete') throw new ContractError('goal_evidence_required', 'use /goal complete EVIDENCE');
    else await engine.setGoal(value);
    return showWorkNotice(workspace, 'Goal updated.');
  }
  if (name === '/task') {
    const [action = '', id = '', ...rest] = value.split(/\s+/u);
    const detail = rest.join(' ').trim();
    if (action === 'add') await engine.addTask([id, ...rest].join(' ').trim());
    else if (action === 'start') await engine.updateTask(id, TASK_STATUS.start);
    else if (action === 'pending') await engine.updateTask(id, TASK_STATUS.pending);
    else if (action === 'complete') await engine.updateTask(id, TASK_STATUS.complete, detail);
    else if (action === 'block') await engine.updateTask(id, TASK_STATUS.block, detail);
    else throw new ContractError('task_command_invalid', 'use /task add TEXT, /task start ID, /task pending ID, /task complete ID EVIDENCE, or /task block ID REASON');
    return showWorkNotice(workspace, `Task ${action === 'add' ? 'added' : `${id.toUpperCase()} updated`}.`);
  }
}

export function openPlan(workspace, selectedId = null, engine = workspace.activeEngine()) {
  workspace.projection.openOverlay(planOverlay(engine.workStatus(), { selectedId }));
}

export async function handleWorkSelection(selected, workspace, overlay) {
  if (!selected || typeof selected.id !== 'string') return false;
  if (!['plan', 'work-task'].includes(overlay.kind)) return false;
  const engine = workspace.activeEngine();
  if (overlay.kind === 'plan' && selected.id.startsWith(TASK_PREFIX)) {
    const id = selected.id.slice(TASK_PREFIX.length);
    workspace.projection.openOverlay(taskOverlay(engine.workStatus(), id));
    return true;
  }
  if (overlay.kind === 'plan' && selected.id === 'action:goal-reopen') {
    await engine.reopenGoal();
    openPlan(workspace, null, engine);
    return true;
  }
  if (overlay.kind === 'work-task') {
    const [action, id] = selected.id.slice(ACTION_PREFIX.length).split(':');
    if (action === 'start' || action === 'pending') {
      await engine.updateTask(id, TASK_STATUS[action]);
      openPlan(workspace, `${TASK_PREFIX}${id}`, engine);
      return true;
    }
    if (action === 'complete' || action === 'block') {
      workspace.projection.closeOverlay();
      const editor = workspace.projection.active?.()?.editor;
      if (!editor) throw new ContractError('work_editor_unavailable', 'no active editor is available');
      editor.set(`/task ${action} ${id} `);
      workspace.projection.showNotice(WORK_NOTICE_CATEGORY, action === 'complete'
        ? 'Describe the completion evidence, then press Enter.'
        : 'Describe the blocking reason, then press Enter.');
      return true;
    }
  }
  return false;
}

function showWorkNotice(workspace, text) {
  workspace.projection.showNotice(WORK_NOTICE_CATEGORY, text);
  workspace.onChange();
}
