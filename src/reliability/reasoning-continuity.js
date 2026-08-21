// SPDX-License-Identifier: Apache-2.0

const MAX_REASONING_CONTINUITY_BYTES = 262_144;
const REASONING_CONTEXT_FRACTION = 0.25;

export function appendReasoningChunk(current, chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) return current ?? '';
  return utf8Suffix(`${current ?? ''}${chunk}`, MAX_REASONING_CONTINUITY_BYTES);
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
  active.reasoningContinuations ??= [];
  active.reasoningContinuations.push(entry);
  if (active.reasoningContinuations.length > 64) active.reasoningContinuations.splice(0, active.reasoningContinuations.length - 64);
  active.enrichment.reasoningContinuations = active.reasoningContinuations;
  return true;
}

export function boundedReasoningContinuations(entries = [], maxContextBytes = Number.MAX_SAFE_INTEGER) {
  const available = Number.isFinite(maxContextBytes)
    ? Math.max(0, Math.floor(maxContextBytes * REASONING_CONTEXT_FRACTION))
    : MAX_REASONING_CONTINUITY_BYTES;
  let remaining = Math.min(MAX_REASONING_CONTINUITY_BYTES, available);
  const selected = new Map();
  for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry.providerCallId !== 'string' || typeof entry.reasoningContent !== 'string') continue;
    const content = utf8Suffix(entry.reasoningContent, remaining);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes === 0) continue;
    selected.set(entry.providerCallId, Object.freeze({ ...entry, reasoningContent: content }));
    remaining -= bytes;
  }
  return selected;
}

function utf8Suffix(value, maximum) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximum) return value;
  return encoded.subarray(encoded.length - maximum).toString('utf8').replace(/^\uFFFD/gu, '');
}
