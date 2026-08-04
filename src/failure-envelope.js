// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function failureEnvelope(error, options = {}) {
  const known = error instanceof ContractError;
  const code = known ? error.code : 'internal_failure';
  const operation = options.operation ?? 'runtime';
  const mission = known && typeof error.missionId === 'string' ? {
    mission_id: error.missionId,
    mission_condition: error.missionCondition,
    cause_code: error.causeCode,
  } : {};
  return Object.freeze({
    code, category: failureCategory(code), boundary: options.boundary ?? boundaryFor(code, operation),
    message: known ? error.message : 'internal operation failed', retryable: known ? error.retryable : false,
    cause_id: options.causeId ?? `${operation}:${code}`,
    partial_data: Boolean(options.partial), partial: Boolean(options.partial),
    effect_certainty: options.effectCertainty ?? 'none',
    side_effect_certainty: options.effectCertainty ?? 'none',
    ...mission,
  });
}

function failureCategory(code) {
  if (/timeout/u.test(code)) return 'timeout';
  if (/cancel/u.test(code)) return 'cancelled';
  if (/permission|review|authority|denied/u.test(code)) return 'authorization';
  if (/config|manifest|version|protocol|schema|invalid/u.test(code)) return 'contract';
  if (/provider/u.test(code)) return 'provider';
  if (/tool|process|edit|delete|file/u.test(code)) return 'tool';
  if (/persist|journal|store|ledger/u.test(code)) return 'persistence';
  if (/mcp/u.test(code)) return 'mcp';
  if (/memory/u.test(code)) return 'memory';
  if (/hook|event|subscriber/u.test(code)) return 'extension';
  return 'internal';
}

function boundaryFor(code, fallback) {
  for (const value of ['provider', 'tool', 'persistence', 'shutdown', 'memory', 'mcp', 'hook', 'permission']) {
    if (code.includes(value)) return value;
  }
  return fallback;
}
