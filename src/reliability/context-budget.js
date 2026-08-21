// SPDX-License-Identifier: Apache-2.0
import { measureContext } from '../context.js';
import { DEFAULT_MODEL_OUTPUT_TOKENS } from './output-headroom.js';

// Conservative empirical approximation used only when a provider tokenizer is unavailable.
const TOKEN_BYTE_RATIO = 3;
const MESSAGE_OVERHEAD_TOKENS = 8;
// Reserve 12.5% for output, targeting at least 1K tokens without consuming more
// than 25% of a small context window or exceeding provider/window constraints.
const OUTPUT_RESERVE_RATIO = 0.125;
const TARGET_MIN_OUTPUT_RESERVE_TOKENS = 1024;
const MAX_OUTPUT_RESERVE_TOKENS = DEFAULT_MODEL_OUTPUT_TOKENS;

export function contextBudget(config, routes, runtime, retryScale = 1) {
  const knownBytes = routes.slice(0, routes[0]?.budget ?? routes.length)
    .map((route) => route.contextLimitBytes).filter(positive);
  if (positive(runtime?.contextLimitBytes)) knownBytes.push(runtime.contextLimitBytes);
  const hardLimitBytes = Math.min(config.limits.maxContextBytes, ...(knownBytes.length ? knownBytes : [config.limits.maxContextBytes]));
  const windowTokens = positiveValue(runtime?.contextWindowTokens);
  const declaredOutputLimit = positiveValue(runtime?.outputLimitTokens)
    ?? positiveValue(routes[0]?.maxOutputTokens) ?? DEFAULT_MODEL_OUTPUT_TOKENS;
  const outputReserveTokens = windowTokens ? adaptiveOutputReserve(windowTokens, declaredOutputLimit) : null;
  const effectiveInputTokens = windowTokens ? Math.max(1, windowTokens - outputReserveTokens) : null;
  const compactionThreshold = config.limits.contextCompactionThreshold ?? 0.75;
  const compressionThreshold = config.limits.contextCompressionThreshold ?? 0.40;
  const compressionLevel2Threshold = config.limits.contextCompressionLevel2Threshold ?? 0.55;
  const compressionLevel3Threshold = config.limits.contextCompressionLevel3Threshold ?? 0.70;
  const thresholdTokens = effectiveInputTokens
    ? Math.max(1, Math.floor(effectiveInputTokens * compactionThreshold)) : null;
  const scaledTokens = thresholdTokens ? Math.max(1, Math.floor(thresholdTokens * retryScale)) : null;
  const thresholdBytes = Math.min(
    Math.floor(hardLimitBytes * compactionThreshold * retryScale),
    scaledTokens ? scaledTokens * TOKEN_BYTE_RATIO : Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({
    hardLimitBytes, thresholdBytes, windowTokens, outputReserveTokens,
    effectiveInputTokens, thresholdTokens, scaledTokens,
    compressionThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionThreshold)) : null,
    compressionLevel2ThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionLevel2Threshold)) : null,
    compressionLevel3ThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionLevel3Threshold)) : null,
    source: runtime?.source ?? 'configured_bytes', compactionThreshold, compressionThreshold,
    compressionLevel2Threshold, compressionLevel3Threshold,
    parallelCapacity: positiveValue(runtime?.parallelCapacity),
    estimated: true,
  });
}

function adaptiveOutputReserve(windowTokens, declaredOutputLimit) {
  const proportionalReserve = Math.floor(windowTokens * OUTPUT_RESERVE_RATIO);
  const smallWindowSafetyCap = Math.max(1, Math.floor(windowTokens * 0.25));
  const constrainedMinimum = Math.min(
    TARGET_MIN_OUTPUT_RESERVE_TOKENS,
    smallWindowSafetyCap,
  );
  const desiredReserve = Math.max(constrainedMinimum, proportionalReserve, declaredOutputLimit);
  const providerReserveCap = Math.min(declaredOutputLimit, MAX_OUTPUT_RESERVE_TOKENS);
  const inputPreservingCap = windowTokens - 1;
  return Math.max(1, Math.min(inputPreservingCap, smallWindowSafetyCap, providerReserveCap, desiredReserve));
}

export function estimateContextTokens(messages) {
  return messages.reduce((total, item) => {
    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item);
    return total + Math.ceil(Buffer.byteLength(content, 'utf8') / TOKEN_BYTE_RATIO)
      + MESSAGE_OVERHEAD_TOKENS;
  }, 0);
}

export function contextMeasurements(messages) {
  return Object.freeze({ bytes: measureContext(messages), estimatedTokens: estimateContextTokens(messages) });
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveValue(value) {
  return positive(value) ? value : null;
}
