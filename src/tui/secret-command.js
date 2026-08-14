// SPDX-License-Identifier: Apache-2.0
import { secretsOverlay } from './overlays.js';

export async function handleSecretsCommand(argument, workspace) {
  if (argument.trim()) throw Object.assign(new Error('use /secrets and the keyboard-driven manager'), { code: 'secret_command_invalid' });
  await openSecretsManager(workspace);
}

export async function openSecretsManager(workspace, options = {}) {
  workspace.projection.openOverlay(secretsOverlay(await workspace.listSecrets(), options));
}
