// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const FAILURE_DOMAINS = Object.freeze({
  provider: Object.freeze({ category: 'provider', boundary: 'provider' }),
  route: Object.freeze({ category: 'provider', boundary: 'provider' }),
  model: Object.freeze({ category: 'provider', boundary: 'provider' }),
  tool: Object.freeze({ category: 'tool', boundary: 'tool' }),
  process: Object.freeze({ category: 'tool', boundary: 'tool' }),
  shell: Object.freeze({ category: 'tool', boundary: 'tool' }),
  edit: Object.freeze({ category: 'tool', boundary: 'tool' }),
  read: Object.freeze({ category: 'tool', boundary: 'tool' }),
  file: Object.freeze({ category: 'tool', boundary: 'tool' }),
  filesystem: Object.freeze({ category: 'tool', boundary: 'tool' }),
  web: Object.freeze({ category: 'tool', boundary: 'tool' }),
  browser: Object.freeze({ category: 'tool', boundary: 'tool' }),
  image: Object.freeze({ category: 'tool', boundary: 'tool' }),
  lsp: Object.freeze({ category: 'tool', boundary: 'tool' }),
  git: Object.freeze({ category: 'tool', boundary: 'tool' }),
  project: Object.freeze({ category: 'tool', boundary: 'tool' }),
  verification: Object.freeze({ category: 'tool', boundary: 'tool' }),
  persistence: Object.freeze({ category: 'persistence', boundary: 'persistence' }),
  journal: Object.freeze({ category: 'persistence', boundary: 'persistence' }),
  store: Object.freeze({ category: 'persistence', boundary: 'persistence' }),
  ledger: Object.freeze({ category: 'persistence', boundary: 'persistence' }),
  reviewer: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  review: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  permission: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  authority: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  governance: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  preauthorization: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  principal: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  credential: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  secret: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  mcp: Object.freeze({ category: 'mcp', boundary: 'mcp' }),
  memory: Object.freeze({ category: 'memory', boundary: 'memory' }),
  hook: Object.freeze({ category: 'extension', boundary: 'hook' }),
  event: Object.freeze({ category: 'extension', boundary: 'hook' }),
  subscriber: Object.freeze({ category: 'extension', boundary: 'hook' }),
  extension: Object.freeze({ category: 'extension', boundary: 'hook' }),
  config: Object.freeze({ category: 'contract', boundary: null }),
  configuration: Object.freeze({ category: 'contract', boundary: null }),
  manifest: Object.freeze({ category: 'contract', boundary: null }),
  invalid: Object.freeze({ category: 'contract', boundary: null }),
  protocol: Object.freeze({ category: 'contract', boundary: null }),
  schema: Object.freeze({ category: 'contract', boundary: null }),
  version: Object.freeze({ category: 'contract', boundary: null }),
  shutdown: Object.freeze({ category: 'internal', boundary: 'shutdown' }),
});

const FAILURE_CODE_OVERRIDES = Object.freeze({
  duplicate_provider: FAILURE_DOMAINS.provider,
  empty_model_output: FAILURE_DOMAINS.provider,
  missing_provider: FAILURE_DOMAINS.provider,
  no_eligible_vision_route: FAILURE_DOMAINS.provider,
  // Compatibility: keep the historical reason code while assigning ownership
  // to the provider stream boundary where identity fragments originate.
  tool_identity_drift: FAILURE_DOMAINS.provider,
});

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
  const exact = FAILURE_CODE_OVERRIDES[code];
  if (exact) return exact;
  // Invariant: the first underscore-delimited token is the reason-code ownership namespace,
  // not a substring heuristic. New cross-domain exceptions require an explicit override.
  const separator = code.indexOf('_');
  const namespace = separator < 0 ? code : code.slice(0, separator);
  return FAILURE_DOMAINS[namespace] ?? null;
}
