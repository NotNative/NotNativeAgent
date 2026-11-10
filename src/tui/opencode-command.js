// SPDX-License-Identifier: Apache-2.0
import { opencodeOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

const OPENCODE_ACTIONS = Object.freeze({
  status: 'status', start: 'start', stop: 'stop', enable: 'enable', disable: 'disable',
});

export async function handleOpencodeCommand(argument, workspace) {
  const normalized = typeof argument === 'string' ? argument.trim() : '';
  const values = normalized ? normalized.split(/\s+/u) : [OPENCODE_ACTIONS.status];
  validateOpencodeArguments(values);
  const result = await workspace.opencodeCommand(values);
  const status = await workspace.opencodeCommand([OPENCODE_ACTIONS.status]);
  workspace.projection.openOverlay(opencodeOverlay(status, {
    message: values[0] === OPENCODE_ACTIONS.status ? null : opencodeMessage(values[0], result),
  }));
}

export async function handleOpencodeSelection(selectedId, workspace) {
  validateOpencodeArguments([selectedId]);
  const result = await workspace.opencodeCommand([selectedId]);
  const status = await workspace.opencodeCommand([OPENCODE_ACTIONS.status]);
  workspace.projection.openOverlay(opencodeOverlay(status, {
    selectedId, message: opencodeMessage(selectedId, result),
  }));
}

function validateOpencodeArguments(values) {
  const action = values[0];
  if (!Object.values(OPENCODE_ACTIONS).includes(action) || values.length !== 1) {
    throw new ContractError('opencode_tui_command_invalid',
      'Use /opencode status|start|stop|enable|disable.');
  }
}

function opencodeMessage(action, result) {
  if (action === OPENCODE_ACTIONS.start) {
    return result?.started === false ? `OpenCode service was already ${result.reason === 'already_running' ? 'running' : 'starting'}.`
      : 'OpenCode service started; the OpenChamber binding is current.';
  }
  if (action === OPENCODE_ACTIONS.stop) {
    return result?.stopped === false ? 'OpenCode service was already stopped.' : 'OpenCode service stopped; the OpenChamber binding was cleared.';
  }
  if (action === OPENCODE_ACTIONS.enable) return 'OpenCode service enabled at sign-in.';
  if (action === OPENCODE_ACTIONS.disable) return 'OpenCode service disabled at sign-in.';
  return 'OpenCode service configuration updated.';
}
