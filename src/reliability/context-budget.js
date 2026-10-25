// SPDX-License-Identifier: Apache-2.0
import { measureContext } from '../context.js';
import { DEFAULT_MODEL_OUTPUT_TOKENS } from './output-headroom.js';

// Conservative empirical approximation used only for ASCII when a provider tokenizer is unavailable.
const TOKEN_BYTE_RATIO = 3;
const MESSAGE_OVERHEAD_TOKENS = 8;
// Reserve 12.5% for output, targeting at least 1K tokens without consuming more
// than 25% of a small context window or exceeding provider/window constraints.
const OUTPUT_RESERVE_RATIO = 0.125;
const TARGET_MIN_OUTPUT_RESERVE_TOKENS = 1024;
const MAX_OUTPUT_RESERVE_TOKENS = DEFAULT_MODEL_OUTPUT_TOKENS;
const CONSERVATIVE_UNKNOWN_WINDOW_TOKENS = 65_536;
const MAX_WIRE_BYTES_PER_CONTEXT_TOKEN = 64;

export function contextBudget(config, routes, runtime, retryScale = 1, estimateScale = 1) {
  // Why: an unknown provider window cannot mean unbounded context pressure. A conservative
  // planning window makes compaction activate before a local model rejects an oversized turn.
  const declaredWindowTokens = positiveValue(runtime?.contextWindowTokens);
  const windowTokens = declaredWindowTokens ?? CONSERVATIVE_UNKNOWN_WINDOW_TOKENS;
  const outputLimits = [runtime?.outputLimitTokens, routes[0]?.maxOutputTokens]
    .map(positiveValue).filter((value) => value !== null);
  const declaredOutputLimit = outputLimits.length > 0 ? Math.min(...outputLimits) : null;
  const outputReserveTokens = declaredOutputLimit === null
    ? providerOutputReserve(routes[0], runtime, windowTokens)
    : declaredWindowTokens ? adaptiveOutputReserve(windowTokens, declaredOutputLimit)
      : Math.min(windowTokens - 1, declaredOutputLimit);
  const effectiveInputTokens = windowTokens ? Math.max(1, windowTokens - outputReserveTokens) : null;
  const compactionThreshold = config.limits.contextCompactionThreshold ?? 0.75;
  const compressionThreshold = config.limits.contextCompressionThreshold ?? 0.40;
  const compressionLevel2Threshold = config.limits.contextCompressionLevel2Threshold ?? 0.55;
  const compressionLevel3Threshold = config.limits.contextCompressionLevel3Threshold ?? 0.70;
  const thresholdTokens = effectiveInputTokens
    ? Math.max(1, Math.floor(effectiveInputTokens * compactionThreshold)) : null;
  const conservativeEstimateScale = boundedEstimateScale(estimateScale);
  const scaledTokens = thresholdTokens
    ? Math.max(1, Math.floor((thresholdTokens * retryScale) / conservativeEstimateScale)) : null;
  // Compatibility: legacy byte fields describe token-derived physical allowances, never independent context ceilings.
  const hardLimitBytes = physicalContextAllowance(windowTokens);
  const thresholdBytes = physicalContextAllowance(scaledTokens);
  return Object.freeze({
    hardLimitBytes, thresholdBytes, windowTokens, outputReserveTokens,
    effectiveInputTokens, thresholdTokens, scaledTokens,
    compressionThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionThreshold)) : null,
    compressionLevel2ThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionLevel2Threshold)) : null,
    compressionLevel3ThresholdTokens: effectiveInputTokens
      ? Math.max(1, Math.floor(effectiveInputTokens * compressionLevel3Threshold)) : null,
    source: declaredWindowTokens ? runtime?.source ?? 'declared' : 'conservative_unknown', compactionThreshold, compressionThreshold,
    compressionLevel2Threshold, compressionLevel3Threshold,
    parallelCapacity: positiveValue(runtime?.parallelCapacity), estimateScale: conservativeEstimateScale,
    estimated: true,
  });
}

export function adaptiveOutputReserve(windowTokens, declaredOutputLimit) {
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

// Why: a provider request is bounded by the ceiling it actually sends. An absent
// provider cap is not permission to reserve the largest route default; measuring
// and enforcing against a reserve the wire never carries understates usable input.
export function providerOutputReserve(route, runtime, windowTokens) {
  const routeLimit = positiveValue(route?.maxOutputTokens);
  const providerLimit = positiveValue(runtime?.outputLimitTokens);
  if (routeLimit !== null && providerLimit !== null) return Math.min(routeLimit, providerLimit);
  const declared = routeLimit ?? providerLimit;
  const window = positiveValue(windowTokens);
  if (declared !== null) return window !== null ? adaptiveOutputReserve(window, declared) : declared;
  return window !== null ? adaptiveOutputReserve(window, MAX_OUTPUT_RESERVE_TOKENS) : TARGET_MIN_OUTPUT_RESERVE_TOKENS;
}

export function estimateContextTokens(messages) {
  return messages.reduce((total, item) => {
    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item);
    return total + estimateUtf8Tokens(content) + MESSAGE_OVERHEAD_TOKENS;
  }, 0);
}

export function estimateUtf8Tokens(value) {
  const text = String(value ?? '');
  let asciiBytes = 0; let nonAsciiUtf16Units = 0;
  for (const symbol of text) {
    if (symbol.codePointAt(0) <= 0x7f) asciiBytes += 1;
    else nonAsciiUtf16Units += symbol.length;
  }
  // Why: bytes/3 is useful for ordinary English but can undercount combining characters,
  // emoji, and tokenizers that split non-Latin scripts finely. Counting each non-ASCII UTF-16
  // unit keeps the dependency-free fallback cautious without tripling ordinary ASCII prompts.
  return Math.ceil(asciiBytes / TOKEN_BYTE_RATIO) + nonAsciiUtf16Units;
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

function boundedEstimateScale(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : 1;
}

export function physicalContextAllowance(tokens) {
  const count = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : CONSERVATIVE_UNKNOWN_WINDOW_TOKENS;
  // Compatibility: context byte projections retain their historical scale; token accounting
  // governs context admission. Protocol transport uses a separate, narrower envelope.
  return Math.min(Number.MAX_SAFE_INTEGER, count * 768);
}

export function physicalWireAllowance(tokens) {
  const count = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : CONSERVATIVE_UNKNOWN_WINDOW_TOKENS;
  // Why: bound bytes retained before JSON parsing. This covers ordinary UTF-8 and escaped
  // JSON with substantial headroom over the dependency-free ASCII token estimate.
  return Math.min(Number.MAX_SAFE_INTEGER, count * MAX_WIRE_BYTES_PER_CONTEXT_TOKEN);
}
