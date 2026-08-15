// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const RETIRED_AUTHORITY_MESSAGE = 'use nna integration serve; fixed-port secret broker authority has been retired';

export async function runSecretBrokerCommand(_prompt, _paths, _io) {
  throw new ContractError('secret_broker_authority_retired', RETIRED_AUTHORITY_MESSAGE);
}
