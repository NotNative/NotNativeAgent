// SPDX-License-Identifier: Apache-2.0
import { measureContext } from './context.js';

const TOKEN_BYTE_RATIO = 3;
const SAFETY_BUFFER_TOKENS = 13_000;

export function contextBudget(config, routes, runtime, retryScale = 1) {
  const knownBytes = routes.slice(0, routes[0]?.budget ?? 1)
    .map((route) => route.contextLimitBytes).filter(positive);
  if (positive(runtime?.contextLimitBytes)) knownBytes.push(runtime.contextLimitBytes);
  const hardLimitBytes = Math.min(config.limits.maxContextBytes, ...(knownBytes.length ? knownBytes : [config.limits.maxContextBytes]));
  const windowTokens = positiveValue(runtime?.contextWindowTokens);
  const outputReserveTokens = windowTokens
    ? Math.min(windowTokens - 1, positiveValue(runtime?.outputLimitTokens) ?? positiveValue(routes[0]?.maxOutputTokens) ?? 4096)
    : null;
  const effectiveInputTokens = windowTokens ? Math.max(1, windowTokens - outputReserveTokens) : null;
  const thresholdTokens = effectiveInputTokens ? Math.max(1, Math.min(
    Math.floor(effectiveInputTokens * config.limits.contextCompactionThreshold),
    Math.max(1, effectiveInputTokens - SAFETY_BUFFER_TOKENS),
  )) : null;
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
