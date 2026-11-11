// SPDX-License-Identifier: Apache-2.0
import { gatewayOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

const GATEWAY_ACTIONS = Object.freeze({
  status: 'status', test: 'test', start: 'start', stop: 'stop', authorize: 'authorize', revoke: 'revoke',
});

/** What to say while an action waits on the network or a process. */
const GATEWAY_PENDING = Object.freeze({
  start: 'Starting the gateway...',
  stop: 'Stopping the gateway...',
  test: 'Testing the gateway connection...',
  authorize: 'Authorizing the operator...',
  revoke: 'Revoking the operator...',
});

export async function handleGatewayCommand(argument, workspace) {
  const normalized = typeof argument === 'string' ? argument.trim() : '';
  const values = normalized ? normalized.split(/\s+/u) : [GATEWAY_ACTIONS.status];
  validateGatewayArguments(values);
  if (values[0] === GATEWAY_ACTIONS.status) {
    workspace.projection.openOverlay(gatewayOverlay(await workspace.gatewayCommand(values)));
    return;
  }
  // Why painted first: these actions wait on a process or the network, and a menu
  // that shows nothing until they finish reads as a dropped keypress.
  await paintGateway(workspace, values[0], await workspace.gatewayCommand([GATEWAY_ACTIONS.status]).catch(() => null),
    GATEWAY_PENDING[values[0]]);
  const result = await workspace.gatewayCommand(values);
  await paintGateway(workspace, values[0], await workspace.gatewayCommand([GATEWAY_ACTIONS.status]).catch(() => null),
    null, gatewayMessage(values[0], result));
}

export async function handleGatewaySelection(selectedId, workspace) {
  validateGatewayArguments([selectedId]);
  await paintGateway(workspace, selectedId, await workspace.gatewayCommand([GATEWAY_ACTIONS.status]).catch(() => null),
    GATEWAY_PENDING[selectedId]);
  const result = await workspace.gatewayCommand([selectedId]);
  await paintGateway(workspace, selectedId, await workspace.gatewayCommand([GATEWAY_ACTIONS.status]).catch(() => null),
    null, gatewayMessage(selectedId, result));
}

/** Paints one overlay state and repaints it, so a pending action is visible. */
async function paintGateway(workspace, selectedId, status, pending, message = null) {
  workspace.projection.openOverlay(gatewayOverlay(status, {
    selectedId, ...(pending ? { pending } : {}), ...(message ? { message } : {}),
  }));
  workspace.projection.requestRender?.();
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
