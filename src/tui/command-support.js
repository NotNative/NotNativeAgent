// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function strictInteger(value, label) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ContractError('config_command_invalid', `${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ContractError('config_command_invalid', `${label} must be an integer`);
  return parsed;
}

export function modelNotice(workspace) {
  const session = activeSession(workspace);
  return `${session.metadata.model ?? 'Model'} selected as this conversation's temporary model override.`;
}

export function routeNotice(workspace) {
  const session = activeSession(workspace);
  const scope = session.role === 'primary' ? 'workspace default' : 'this conversation';
  return `${session.metadata.endpoint ?? session.metadata.provider} · ${session.metadata.model} selected for ${scope}.`;
}

function activeSession(workspace) {
  const session = workspace?.projection?.active?.();
  if (!session || !session.metadata || typeof session.metadata !== 'object') {
    throw new ContractError('tui_session_missing', 'no active conversation route is available');
  }
  return session;
}
