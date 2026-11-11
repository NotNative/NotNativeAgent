// SPDX-License-Identifier: Apache-2.0
import { opencodeOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

const OPENCODE_ACTIONS = Object.freeze({
  status: 'status', start: 'start', stop: 'stop', enable: 'enable', disable: 'disable',
});

/**
 * What to say while an action is still running.
 *
 * Why this exists: starting the service waits on a spawned process, which takes
 * long enough that a silent menu reads as a dropped keypress. The overlay is
 * painted before the work begins and repainted after it lands, so the operator
 * always sees either progress or the outcome.
 */
const PENDING = Object.freeze({
  start: 'Starting the OpenCode service and applying the OpenChamber binding...',
  stop: 'Stopping the OpenCode service and clearing the OpenChamber binding...',
  enable: 'Installing the sign-in script...',
  disable: 'Removing the sign-in script...',
});

export async function handleOpencodeCommand(argument, workspace) {
  const normalized = typeof argument === 'string' ? argument.trim() : '';
  const values = normalized ? normalized.split(/\s+/u) : [OPENCODE_ACTIONS.status];
  validateOpencodeArguments(values);
  const action = values[0];
  if (action === OPENCODE_ACTIONS.status) {
    workspace.projection.openOverlay(opencodeOverlay(await workspace.opencodeCommand([action])));
    return;
  }
  // Paint the state we know before waiting, so the menu never looks inert.
  await paint(workspace, action, null, PENDING[action]);
  const result = await workspace.opencodeCommand(values);
  await paint(workspace, action, result, null);
}

export async function handleOpencodeSelection(selectedId, workspace) {
  validateOpencodeArguments([selectedId]);
  await paint(workspace, selectedId, null, PENDING[selectedId]);
  const result = await workspace.opencodeCommand([selectedId]);
  await paint(workspace, selectedId, result, null);
}

/**
 * Shows the overlay for one action, with a pending line or the result.
 *
 * Why the status is re-read after the action: the overlay's own lines describe the
 * service, so they must come from the state the action produced, not the state
 * before it. While pending, the last known state still shows — labelled by the
 * pending line — rather than an empty menu.
 */
async function paint(workspace, action, result, pending) {
  const status = await workspace.opencodeCommand([OPENCODE_ACTIONS.status]).catch(() => null);
  workspace.projection.openOverlay(opencodeOverlay(status, {
    selectedId: action,
    ...(pending ? { pending } : {}),
    ...(result ? { message: opencodeMessage(action, result) } : {}),
  }));
  workspace.projection.requestRender?.();
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
