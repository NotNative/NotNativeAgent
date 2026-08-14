// SPDX-License-Identifier: Apache-2.0
import { gatewayOverlay } from './overlays.js';

export async function handleGatewayCommand(argument, workspace) {
  const values = argument.trim() ? argument.trim().split(/\s+/u) : ['status'];
  const result = await workspace.gatewayCommand(values);
  const status = values[0] === 'status' ? result : await workspace.gatewayCommand(['status']);
  workspace.projection.openOverlay(gatewayOverlay(status, {
    message: values[0] === 'status' ? null : gatewayMessage(values[0], result),
  }));
}

export async function handleGatewaySelection(selectedId, workspace) {
  const result = await workspace.gatewayCommand([selectedId]);
  const current = await workspace.gatewayCommand(['status']);
  workspace.projection.openOverlay(gatewayOverlay(current, {
    selectedId, message: gatewayMessage(selectedId, result),
  }));
}

function gatewayMessage(action, result) {
  if (action === 'test') return `Telegram connection ready for @${result.bot.username ?? result.bot.id}.`;
  if (action === 'start') return result.started === false ? 'Gateway was already running.' : 'Gateway started.';
  if (action === 'stop') return result.stopped === false ? 'Gateway was already stopped.' : 'Gateway stop requested.';
  if (action === 'authorize') return 'Telegram operator authorized.';
  if (action === 'revoke') return 'Telegram operator revoked.';
  return 'Gateway configuration updated.';
}
