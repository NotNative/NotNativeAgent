// SPDX-License-Identifier: Apache-2.0

const MAX_REASONING_BLOCK_BYTES = 262_144;

export function appendReasoningChunk(current, chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) return current ?? '';
  const combined = `${current ?? ''}${chunk}`;
  return Buffer.byteLength(combined, 'utf8') <= MAX_REASONING_BLOCK_BYTES ? combined : null;
}

export function captureReasoningContinuation(active, calls = []) {
  const text = active?.stepReasoningText;
  const providerCallId = calls.find((call) => typeof call?.providerCallId === 'string')?.providerCallId;
  if (active?.stepReasoningReplayable !== true || typeof text !== 'string' || text.length === 0 || !providerCallId) return false;
  const entry = Object.freeze({
    stepId: active.stepId, providerCallId,
    providerProfile: active.providerResource, model: active.modelName,
    reasoningContent: text,
  });
  if (!Array.isArray(active.reasoningContinuations)) active.reasoningContinuations = [];
  active.reasoningContinuations.push(entry);
  if (active.reasoningContinuations.length > 64) active.reasoningContinuations.splice(0, active.reasoningContinuations.length - 64);
  if (!active.enrichment || typeof active.enrichment !== 'object' || Array.isArray(active.enrichment)) {
    active.enrichment = {};
  }
  active.enrichment.reasoningContinuations = active.reasoningContinuations;
  return true;
}

export function boundedReasoningContinuations(entries = [], availableBytes = Number.MAX_SAFE_INTEGER, measure = reasoningBytes) {
  let remaining = Number.isFinite(availableBytes) ? Math.max(0, Math.floor(availableBytes)) : Number.MAX_SAFE_INTEGER;
  const selected = new Map();
  for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry.providerCallId !== 'string' || typeof entry.reasoningContent !== 'string') continue;
    const bytes = measure(entry);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
    if (bytes > remaining) break;
    selected.set(entry.providerCallId, entry);
    remaining -= bytes;
  }
  return selected;
}

function reasoningBytes(entry) {
  return Buffer.byteLength(entry.reasoningContent, 'utf8');
}
