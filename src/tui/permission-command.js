// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from '../ids.js';
import { valueOverlay } from './overlays.js';

const AUTHENTICATED_INTERACTIVE_OPERATOR = 'authenticated-interactive-operator';

export function permissionChoice(text, choices = null) {
  const available = Array.isArray(choices) ? choices : ['allow_once', 'allow_session', 'allow_workspace', 'deny'];
  const index = typeof text === 'string' && /^[1-9]\d*$/u.test(text) ? Number(text) - 1 : -1;
  return available[index] ?? null;
}

export function handlePermissionCommand(argument, workspace) {
  const broker = workspace?.activeEngine?.()?.permissionBroker;
  if (!broker || typeof broker.grants !== 'function' || typeof broker.revoke !== 'function') {
    throw new ContractError('permissions_unavailable', 'conversation preauthorizations are unavailable');
  }
  if (!argument) {
    workspace.projection.openOverlay(valueOverlay('permissions', 'Conversation preauthorizations', broker.grants()));
    return;
  }
  const [action, id, ...extra] = argument.split(/\s+/u);
  if (action !== 'revoke' || !id || extra.length) {
    throw new ContractError('permissions_command_invalid', 'use /permissions or /permissions revoke ID');
  }
  requireExternalId(id, 'grant_id');
  const result = broker.revoke(id, AUTHENTICATED_INTERACTIVE_OPERATOR);
  workspace.projection.openOverlay(valueOverlay('permissions', 'Conversation preauthorization revoked', result));
}
