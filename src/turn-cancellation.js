// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function assertTurnActive(active) {
  if (active.cancelled || active.controller.signal.aborted) {
    throw new ContractError('turn_cancelled', 'turn was cancelled');
  }
}
