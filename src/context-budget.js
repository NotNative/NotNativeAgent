// SPDX-License-Identifier: Apache-2.0
import { measureContext } from './context.js';

const TOKEN_BYTE_RATIO = 3;
const OUTPUT_RESERVE_RATIO = 0.125;
const MIN_OUTPUT_RESERVE_TOKENS = 1024;
const MAX_OUTPUT_RESERVE_TOKENS = 16_384;

export function contextBudget(config, routes, runtime, retryScale = 1) {
  const knownBytes = routes.slice(0, routes[0]?.budget ?? 1)
    .map((route) => route.contextLimitBytes).filter(positive);
  if (positive(runtime?.contextLimitBytes)) knownBytes.push(runtime.contextLimitBytes);
  const hardLimitBytes = Math.min(config.limits.maxContextBytes, ...(knownBytes.length ? knownBytes : [config.limits.maxContextBytes]));
  const windowTokens = positiveValue(runtime?.contextWindowTokens);
  const declaredOutputLimit = positiveValue(runtime?.outputLimitTokens)
    ?? positiveValue(routes[0]?.maxOutputTokens) ?? 4096;
  const outputReserveTokens = windowTokens ? adaptiveOutputReserve(windowTokens, declaredOutputLimit) : null;
  const effectiveInputTokens = windowTokens ? Math.max(1, windowTokens - outputReserveTokens) : null;
  const thresholdTokens = effectiveInputTokens
    ? Math.max(1, Math.floor(effectiveInputTokens * config.limits.contextCompactionThreshold)) : null;
  const scaledTokens = thresholdTokens ? Math.max(1, Math.floor(thresholdTokens * retryScale)) : null;
  const thresholdBytes = Math.min(
    Math.floor(hardLimitBytes * config.limits.contextCompactionThreshold * retryScale),
    scaledTokens ? scaledTokens * TOKEN_BYTE_RATIO : Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({
    hardLimitBytes, thresholdBytes, windowTokens, outputReserveTokens,
    effectiveInputTokens, thresholdTokens, scaledTokens,
    source: runtime?.source ?? 'configured_bytes',
    parallelCapacity: positiveValue(runtime?.parallelCapacity),
    estimated: true,
  });
}

function adaptiveOutputReserve(windowTokens, declaredOutputLimit) {
  const proportional = Math.floor(windowTokens * OUTPUT_RESERVE_RATIO);
  const smallWindowFloor = Math.max(1, Math.floor(windowTokens * 0.25));
  const floor = Math.min(MIN_OUTPUT_RESERVE_TOKENS, smallWindowFloor);
  return Math.max(1, Math.min(
    windowTokens - 1,
    declaredOutputLimit,
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.max(floor, proportional),
  ));
}

export function estimateContextTokens(messages) {
  return messages.reduce((total, item) => {
    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item);
    return total + Math.ceil(Buffer.byteLength(content, 'utf8') / TOKEN_BYTE_RATIO) + 8;
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
