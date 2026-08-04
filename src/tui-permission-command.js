// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { valueOverlay } from './tui-overlays.js';

export function permissionChoice(text) {
  return ({ '1': 'allow_once', '2': 'allow_session', '3': 'allow_workspace', '4': 'deny' })[text] ?? null;
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
