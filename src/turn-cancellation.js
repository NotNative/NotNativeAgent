// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { emitEngineStatus } from './engine/output.js';

export function assertTurnActive(active) {
  if (!active || typeof active !== 'object' || !active.controller?.signal) {
    throw new ContractError('turn_state_invalid', 'active turn cancellation state is unavailable');
  }
  if (active.cancelled || active.controller.signal.aborted) {
    throw new ContractError('turn_cancelled', 'turn was cancelled');
  }
}

// Why: finalization is fail-closed and ignores the abort for terminal phases, so a
// cancel here cannot take effect; a wedged post-commit finalization reports the same.
export async function requestTurnCancel(engine, command) {
  const active = engine.active;
  if (['finalizing_turn', 'idle'].includes(engine.state.state)) {
    return { accepted: false, reason: 'terminal_in_progress', turn_id: active.turnId, request_id: command.request_id };
  }
  if (engine.state.state !== 'cancelling') {
    engine.state.transition('cancelling', { trigger: 'cancel_command', turnId: active.turnId });
  }
  await emitEngineStatus(engine, 'cancelling', active);
  return { accepted: true, turn_id: active.turnId, request_id: command.request_id };
}
