// SPDX-License-Identifier: Apache-2.0
import { dreamOverlay, valueOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

const STATUS_ACTION = 'status';
const RUN_ACTION = 'run';
const MANAGER_ACTIONS = Object.freeze([STATUS_ACTION, 'pause', 'resume', RUN_ACTION]);
const SELECTION_ACTIONS = Object.freeze(['pause', 'resume', RUN_ACTION]);
const CANDIDATES_COMMAND = 'candidates';
const INSPECT_COMMAND = 'inspect';
const CANDIDATE_PREFIX = 'candidate:';
const ACTION_PREFIX = 'action:';
const DETAIL_OVERLAY = 'dream-detail';
const MAINTENANCE_TITLE = 'Idle maintenance';
const CANDIDATE_TITLE = 'Learning candidate';
const ACTION_MESSAGES = Object.freeze({
  pause: 'Maintenance paused.', resume: 'Maintenance resumed.',
  run: 'One bounded maintenance stage completed.',
});

export async function openDreamCommand(argument, workspace) {
  const action = argument.trim();
  if (action && !MANAGER_ACTIONS.includes(action)) {
    workspace.projection.openOverlay(valueOverlay(DETAIL_OVERLAY, MAINTENANCE_TITLE, await workspace.dreamCommand(action)));
    return;
  }
  await openManager(workspace, action);
}

export async function handleDreamSelection(id, workspace) {
  if (id.startsWith(CANDIDATE_PREFIX)) {
    const candidateId = id.slice(CANDIDATE_PREFIX.length);
    if (!candidateId) throw new ContractError('dream_candidate_id_required', 'the dream candidate id is required');
    const candidate = await workspace.dreamCommand(`${INSPECT_COMMAND} ${candidateId}`);
    workspace.projection.openOverlay(Object.freeze({
      ...valueOverlay(DETAIL_OVERLAY, CANDIDATE_TITLE, candidate), parent: 'dream',
    }));
    return;
  }
  const action = id.startsWith(ACTION_PREFIX) ? id.slice(ACTION_PREFIX.length) : STATUS_ACTION;
  if (!SELECTION_ACTIONS.includes(action)) {
    throw new ContractError('dream_action_invalid', `unknown idle-maintenance action: ${action}`);
  }
  const message = ACTION_MESSAGES[action];
  await openManager(workspace, action, { selectedId: id, message });
}

export async function reopenDreamManager(workspace) {
  return openManager(workspace, STATUS_ACTION);
}

async function openManager(workspace, action, options = {}) {
  const status = await workspace.dreamCommand(action);
  const candidates = await workspace.dreamCommand(CANDIDATES_COMMAND);
  workspace.projection.openOverlay(dreamOverlay(status, candidates, options));
}
