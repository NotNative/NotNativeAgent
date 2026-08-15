// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { DreamCoordinator } from '../dream-coordinator.js';

const DREAM_ACTION = Object.freeze({
  status: 'status', candidates: 'candidates', inspect: 'inspect', reject: 'reject',
  pause: 'pause', resume: 'resume', run: 'run',
});
const OPERATOR_REJECTED = 'operator_rejected';
const DREAM_USAGE = 'use /dream [status|pause|resume|run|candidates|inspect ID|reject ID REASON]';

export async function initializeWorkspaceDream(workspace) {
  if (workspace.dream) return workspace.dream.status();
  workspace.dream = new DreamCoordinator({
    workspace, config: workspace.config, path: workspace.options.dataPaths?.dreamState,
  });
  return workspace.dream.initialize();
}

export async function runWorkspaceDreamCommand(workspace, action) {
  if (!workspace.dream) throw new ContractError('dream_unavailable', 'idle maintenance is not initialized');
  const [command = DREAM_ACTION.status, id, ...reasonParts] = String(action ?? '').trim().split(/\s+/u);
  if (command === DREAM_ACTION.status) return workspace.dream.status();
  if (command === DREAM_ACTION.candidates) return workspace.dream.candidates();
  if (command === DREAM_ACTION.inspect) return workspace.dream.candidate(requiredId(id));
  if (command === DREAM_ACTION.reject) return workspace.dream.rejectCandidate(requiredId(id), reasonParts.join(' ') || OPERATOR_REJECTED);
  // pause/resume are synchronous arbiter transitions; status is read only after they return.
  if (command === DREAM_ACTION.pause) workspace.dream.pause();
  else if (command === DREAM_ACTION.resume) workspace.dream.resume();
  else if (command === DREAM_ACTION.run) await workspace.dream.runNow();
  else throw new ContractError('dream_command_invalid', DREAM_USAGE);
  return workspace.dream.status();
}

function requiredId(value) {
  if (!value) throw new ContractError('dream_candidate_id_required', 'the dream candidate id is required');
  return value;
}
