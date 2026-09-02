// SPDX-License-Identifier: Apache-2.0

export function providerModelLimits(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { contextWindowTokens: null, outputLimitTokens: null };
  }
  // Compatibility: OpenAI does not standardize limit metadata on model cards.
  // Keep this vocabulary explicit and shallow so unrelated numeric metadata cannot
  // silently become a context or generation limit.
  const contextWindowTokens = firstPositiveInteger(entry?.top_provider, [
    'context_length', 'context_window',
  ]) ?? firstPositiveInteger(entry, [
    'context_length', 'context_window', 'context_window_tokens', 'max_context_length',
    'max_context_window', 'max_model_len', 'max_total_tokens', 'max_sequence_length',
    'context_size', 'contextLength', 'contextWindow', 'contextWindowTokens',
    'maxContextLength', 'maxContextWindow', 'maxModelLen', 'maxTotalTokens',
    'maxSequenceLength', 'contextSize',
  ]) ?? firstPositiveInteger(entry?.meta, ['n_ctx', 'n_ctx_train']);
  const outputLimitTokens = firstPositiveInteger(entry?.top_provider, [
    'max_completion_tokens', 'max_output_tokens',
  ]) ?? firstPositiveInteger(entry, [
    'max_output_tokens', 'max_completion_tokens', 'output_token_limit',
    'output_limit_tokens', 'max_new_tokens', 'max_tokens', 'maxOutputTokens',
    'maxCompletionTokens', 'outputTokenLimit', 'outputLimitTokens', 'maxNewTokens',
  ]);
  return { contextWindowTokens, outputLimitTokens };
}

function firstPositiveInteger(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of keys) {
    const found = positiveInteger(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
