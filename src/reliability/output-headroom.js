// SPDX-License-Identifier: Apache-2.0

// A reasoning-capable model may consume most of a completion before emitting its
// first visible token or tool call. Keep the completion ceiling separate from
// context-pressure policy so useful reasoning is not mistaken for an empty step.
export const DEFAULT_MODEL_OUTPUT_TOKENS = 32_000;
export const LEGACY_MODEL_OUTPUT_TOKENS = 16_384;
export const OUTPUT_HEADROOM_VERSION = 1;

export function effectiveModelOutputTokens(configured, providerLimit) {
  const requested = positive(configured) ?? DEFAULT_MODEL_OUTPUT_TOKENS;
  const supported = positive(providerLimit);
  return supported ? Math.min(requested, supported) : requested;
}

export function isOutputTruncation(finishReason) {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(String(finishReason ?? '').toLowerCase());
}

export function reachedOutputCeiling(evidence = {}) {
  if (isOutputTruncation(evidence.finishReason)) return true;
  const limit = evidence.outputLimitTokens;
  if (!Number.isSafeInteger(limit) || limit < 1) return false;
  const usage = evidence.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const output = ['completion_tokens', 'output_tokens', 'outputTokens']
    .map((key) => usage[key]).find((value) => Number.isSafeInteger(value) && value >= 0);
  return Number.isSafeInteger(output) && output >= limit;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
