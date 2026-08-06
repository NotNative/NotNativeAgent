// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { planOverlay, taskOverlay } from './tui-overlays.js';

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
    else if (action === 'start') await engine.updateTask(id, 'in_progress');
    else if (action === 'pending') await engine.updateTask(id, 'pending');
    else if (action === 'complete') await engine.updateTask(id, 'completed', detail);
    else if (action === 'block') await engine.updateTask(id, 'blocked', detail);
    else throw new ContractError('task_command_invalid', 'use /task add TEXT, /task start ID, /task pending ID, /task complete ID EVIDENCE, or /task block ID REASON');
    return showWorkNotice(workspace, `Task ${action === 'add' ? 'added' : `${id.toUpperCase()} updated`}.`);
  }
}

export function openPlan(workspace, selectedId = null) {
  workspace.projection.openOverlay(planOverlay(workspace.activeEngine().workStatus(), { selectedId }));
}

export async function handleWorkSelection(selected, workspace, overlay) {
  if (overlay.kind === 'plan' && selected.id.startsWith('task:')) {
    const id = selected.id.slice(5);
    workspace.projection.openOverlay(taskOverlay(workspace.activeEngine().workStatus(), id));
    return true;
  }
  if (overlay.kind === 'plan' && selected.id === 'action:goal-reopen') {
    await workspace.activeEngine().reopenGoal();
    openPlan(workspace);
    return true;
  }
  if (overlay.kind === 'work-task') {
    const [action, id] = selected.id.slice('action:'.length).split(':');
    if (action === 'start' || action === 'pending') {
      await workspace.activeEngine().updateTask(id, action === 'start' ? 'in_progress' : 'pending');
      openPlan(workspace, `task:${id}`);
      return true;
    }
    if (action === 'complete' || action === 'block') {
      workspace.projection.closeOverlay();
      workspace.projection.active().editor.set(`/task ${action} ${id} `);
      workspace.projection.showNotice('work', action === 'complete' ? 'Describe the completion evidence, then press Enter.' : 'Describe the blocking reason, then press Enter.');
      return true;
    }
  }
  return false;
}

function showWorkNotice(workspace, text) {
  workspace.projection.showNotice('work', text);
  workspace.onChange();
}
