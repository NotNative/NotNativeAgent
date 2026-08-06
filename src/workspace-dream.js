// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { DreamCoordinator } from './dream-coordinator.js';

export async function initializeWorkspaceDream(workspace) {
  if (workspace.dream) return workspace.dream.status();
  workspace.dream = new DreamCoordinator({
    workspace, config: workspace.config, path: workspace.options.dataPaths?.dreamState,
  });
  return workspace.dream.initialize();
}

export async function runWorkspaceDreamCommand(workspace, action) {
  if (!workspace.dream) throw new ContractError('dream_unavailable', 'idle maintenance is not initialized');
  const [command = 'status', id, ...reasonParts] = String(action ?? '').trim().split(/\s+/u);
  if (command === 'status') return workspace.dream.status();
  if (command === 'candidates') return workspace.dream.candidates();
  if (command === 'inspect') return workspace.dream.candidate(requiredId(id));
  if (command === 'reject') return workspace.dream.rejectCandidate(requiredId(id), reasonParts.join(' ') || 'operator_rejected');
  if (command === 'pause') workspace.dream.pause();
  else if (command === 'resume') workspace.dream.resume();
  else if (command === 'run') await workspace.dream.runNow();
  else throw new ContractError('dream_command_invalid', 'use /dream [status|pause|resume|run|candidates|inspect ID|reject ID REASON]');
  return workspace.dream.status();
}

function requiredId(value) {
  if (!value) throw new ContractError('dream_candidate_id_required', 'the dream candidate id is required');
  return value;
}
