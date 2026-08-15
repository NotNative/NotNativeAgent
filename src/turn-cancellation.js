// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function assertTurnActive(active) {
  if (!active || typeof active !== 'object' || !active.controller?.signal) {
    throw new ContractError('turn_state_invalid', 'active turn cancellation state is unavailable');
  }
  if (active.cancelled || active.controller.signal.aborted) {
    throw new ContractError('turn_cancelled', 'turn was cancelled');
  }
}
