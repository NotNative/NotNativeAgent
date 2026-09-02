// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { registeredFailureDomain } from './error-code-registry.js';

export function failureEnvelope(error, options = {}) {
  const known = error instanceof ContractError;
  const code = known ? error.code : 'internal_failure';
  const operation = options.operation ?? 'runtime';
  const mission = known && typeof error.missionId === 'string' ? {
    mission_id: error.missionId,
    mission_condition: error.missionCondition,
    mission_policy: error.missionPolicy,
    cause_code: error.causeCode,
  } : {};
  return Object.freeze({
    code, category: failureCategory(code), boundary: options.boundary ?? boundaryFor(code, operation),
    message: known ? error.message : 'internal operation failed', retryable: known ? error.retryable : false,
    cause_id: options.causeId ?? `${operation}:${code}`,
    // Both names are retained for the provider failure contract and the transcript compatibility contract.
    partial_data: Boolean(options.partial), partial: Boolean(options.partial),
    effect_certainty: options.effectCertainty ?? 'none',
    side_effect_certainty: options.sideEffectCertainty ?? options.effectCertainty ?? 'none',
    ...mission,
  });
}

function failureCategory(code) {
  if (code.endsWith('_cancelled')) return 'cancelled';
  if (code.endsWith('_timeout')) return 'timeout';
  return failureDomain(code)?.category ?? 'internal';
}

function boundaryFor(code, fallback) {
  return failureDomain(code)?.boundary ?? fallback;
}

function failureDomain(code) {
  return registeredFailureDomain(code);
}
