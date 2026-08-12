// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
export async function runSecretBrokerCommand() {
  throw new ContractError('secret_broker_authority_retired', 'use nna integration serve; fixed-port secret broker authority has been retired');
}
