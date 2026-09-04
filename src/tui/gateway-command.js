// SPDX-License-Identifier: Apache-2.0
import { gatewayOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

const GATEWAY_ACTIONS = Object.freeze({
  status: 'status', test: 'test', start: 'start', stop: 'stop', authorize: 'authorize', revoke: 'revoke',
});

export async function handleGatewayCommand(argument, workspace) {
  const normalized = typeof argument === 'string' ? argument.trim() : '';
  const values = normalized ? normalized.split(/\s+/u) : [GATEWAY_ACTIONS.status];
  validateGatewayArguments(values);
  const result = await workspace.gatewayCommand(values);
  const status = values[0] === GATEWAY_ACTIONS.status ? result : await workspace.gatewayCommand([GATEWAY_ACTIONS.status]);
  workspace.projection.openOverlay(gatewayOverlay(status, {
    message: values[0] === GATEWAY_ACTIONS.status ? null : gatewayMessage(values[0], result),
  }));
}

export async function handleGatewaySelection(selectedId, workspace) {
  validateGatewayArguments([selectedId]);
  const result = await workspace.gatewayCommand([selectedId]);
  const current = await workspace.gatewayCommand([GATEWAY_ACTIONS.status]);
  workspace.projection.openOverlay(gatewayOverlay(current, {
    selectedId, message: gatewayMessage(selectedId, result),
  }));
}

function validateGatewayArguments(values) {
  const action = values[0];
  const arity = [GATEWAY_ACTIONS.authorize, GATEWAY_ACTIONS.revoke].includes(action) ? 2 : 1;
  if (!Object.values(GATEWAY_ACTIONS).includes(action) || values.length !== arity
    || (arity === 2 && !/^[1-9][0-9]{0,19}$/u.test(values[1]))) {
    throw new ContractError('gateway_tui_command_invalid',
      'Use /gateway status|test|start|stop, or /gateway authorize|revoke <positive Telegram user ID>.');
  }
}

function gatewayMessage(action, result) {
  if (action === GATEWAY_ACTIONS.test) {
    const bot = result?.bot;
    return bot?.username || bot?.id ? `Telegram connection ready for @${bot.username ?? bot.id}.` : 'Telegram connection test completed without bot identity.';
  }
  if (action === GATEWAY_ACTIONS.start) return result?.started === false ? 'Gateway was already running.' : 'Gateway started.';
  if (action === GATEWAY_ACTIONS.stop) return result?.stopped === false ? 'Gateway was already stopped.' : 'Gateway stop requested.';
  if (action === GATEWAY_ACTIONS.authorize) return 'Telegram operator authorized.';
  if (action === GATEWAY_ACTIONS.revoke) return 'Telegram operator revoked.';
  return 'Gateway configuration updated.';
}
