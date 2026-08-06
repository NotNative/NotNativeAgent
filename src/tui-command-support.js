// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function strictInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ContractError('config_command_invalid', `${label} must be an integer`);
  return parsed;
}

export function modelNotice(workspace) {
  return `${workspace.projection.active().metadata.model} selected as this conversation's temporary model override.`;
}

export function routeNotice(workspace) {
  const session = workspace.projection.active();
  const scope = session.role === 'primary' ? 'workspace default' : 'this conversation';
  return `${session.metadata.endpoint ?? session.metadata.provider} · ${session.metadata.model} selected for ${scope}.`;
}
