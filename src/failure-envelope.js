// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const FAILURE_RULES = Object.freeze([
  { category: 'timeout', fragments: ['timeout'] },
  { category: 'cancelled', fragments: ['cancel'] },
  { category: 'authorization', fragments: ['permission', 'review', 'authority', 'denied'] },
  { category: 'contract', fragments: ['config', 'manifest', 'version', 'protocol', 'schema', 'invalid'] },
  { category: 'provider', fragments: ['provider'] },
  { category: 'tool', fragments: ['tool', 'process', 'edit', 'delete', 'file'] },
  { category: 'persistence', fragments: ['persist', 'journal', 'store', 'ledger'] },
  { category: 'mcp', fragments: ['mcp'] },
  { category: 'memory', fragments: ['memory'] },
  { category: 'extension', fragments: ['hook', 'event', 'subscriber'] },
]);
const BOUNDARIES = Object.freeze(['provider', 'tool', 'persistence', 'shutdown', 'memory', 'mcp', 'hook', 'permission']);

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
    // Both names are retained for the provider failure contract and the transcript compatibility contract.
    partial_data: Boolean(options.partial), partial: Boolean(options.partial),
    effect_certainty: options.effectCertainty ?? 'none',
    side_effect_certainty: options.sideEffectCertainty ?? options.effectCertainty ?? 'none',
    ...mission,
  });
}

function failureCategory(code) {
  return FAILURE_RULES.find((rule) => matchesAny(code, rule.fragments))?.category ?? 'internal';
}

function boundaryFor(code, fallback) {
  for (const value of BOUNDARIES) if (code.includes(value)) return value;
  return fallback;
}

function matchesAny(code, fragments) {
  return fragments.some((fragment) => code.includes(fragment));
}
