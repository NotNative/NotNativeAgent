// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { secretsOverlay } from './overlays.js';

export async function handleSecretsCommand(argument, workspace) {
  const normalizedArgument = typeof argument === 'string' ? argument.trim() : '';
  if (normalizedArgument) {
    throw new ContractError('secret_command_invalid', 'use /secrets and the keyboard-driven manager');
  }
  await openSecretsManager(workspace);
}

export async function openSecretsManager(workspace, options = {}) {
  if (!workspace?.projection || typeof workspace.listSecrets !== 'function') {
    throw new ContractError('secret_manager_unavailable', 'secret manager is unavailable');
  }
  workspace.projection.openOverlay(secretsOverlay(await workspace.listSecrets(), options));
}
