// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { valueOverlay } from './tui-overlays.js';

export function permissionChoice(text, choices = null) {
  const available = Array.isArray(choices) ? choices : ['allow_once', 'allow_session', 'allow_workspace', 'deny'];
  return available[Number(text) - 1] ?? null;
}

export function handlePermissionCommand(argument, workspace) {
  const broker = workspace.activeEngine().permissionBroker;
  if (!argument) {
    workspace.projection.openOverlay(valueOverlay('permissions', 'Conversation preauthorizations', broker.grants()));
    return;
  }
  const [action, id, ...extra] = argument.split(/\s+/u);
  if (action !== 'revoke' || !id || extra.length) {
    throw new ContractError('permissions_command_invalid', 'use /permissions or /permissions revoke ID');
  }
  const result = broker.revoke(id, 'authenticated-interactive-operator');
  workspace.projection.openOverlay(valueOverlay('permissions', 'Conversation preauthorization revoked', result));
}
