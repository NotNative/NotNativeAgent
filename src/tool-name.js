// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export const CANONICAL_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export function isCanonicalToolName(value) {
  return typeof value === 'string' && CANONICAL_TOOL_NAME_PATTERN.test(value);
}

export function requireCanonicalToolName(value, code = 'invalid_external_tool') {
  if (!isCanonicalToolName(value)) {
    throw new ContractError(code, 'tool name must match ^[A-Za-z][A-Za-z0-9_]{0,63}$');
  }
  return value;
}
