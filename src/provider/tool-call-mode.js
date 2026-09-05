// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const PROVIDER_TOOL_CALL_MODES = new Set(['single', 'batch']);

export function providerToolCallMode(value) {
  if (value === undefined) return 'single';
  if (!PROVIDER_TOOL_CALL_MODES.has(value)) {
    throw new ContractError('provider_tool_call_mode_invalid', 'provider tool_call_mode must be single or batch');
  }
  return value;
}
