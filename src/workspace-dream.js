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
  if (!action || action === 'status') return workspace.dream.status();
  if (action === 'pause') workspace.dream.pause();
  else if (action === 'resume') workspace.dream.resume();
  else if (action === 'run') await workspace.dream.runNow();
  else throw new ContractError('dream_command_invalid', 'use /dream [status|pause|resume|run]');
  return workspace.dream.status();
}
