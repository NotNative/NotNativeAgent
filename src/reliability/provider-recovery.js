// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { isOutputTruncation } from './output-headroom.js';

export function providerContextLimitDecision(active) {
  const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
  const pressureScale = contextPressureScale(active.runtimeModel);
  const plan = active.recovery.contextLimit(partial, pressureScale, {
    estimatedInputTokens: active.attemptRequestManifest?.envelope?.estimated_input_tokens ?? null,
  });
  if (plan.continue && (!Number.isFinite(plan.scale) || plan.scale <= 0 || plan.scale > 1)) {
    throw new ContractError('context_recovery_invalid', 'context recovery produced an invalid pressure scale');
  }
  return plan;
}

export function reasoningOnlyDecision(active) {
  if (active.stepText.length > 0 || active.stepReasoningBytes === 0 || active.reasoningHeadroomRetryUsed) return null;
  if (isOutputTruncation(active.finishReason) || reachedReportedOutputCeiling(active)) {
    return Object.freeze({ action: active.recovery.reasoningTruncated(), reasoningMode: 'preserve' });
  }
  // Some OpenAI-compatible providers omit a terminal finish reason for a
  // reasoning-only completion. Preserve native reasoning on the bounded retry;
  // the recovery hint, not a thinking-mode mutation, should steer it to action.
  return Object.freeze({ action: active.recovery.reasoningTruncated(), reasoningMode: 'preserve' });
}

function reachedReportedOutputCeiling(active) {
  const limit = active.attemptOutputLimitTokens;
  if (!Number.isSafeInteger(limit) || limit < 1) return false;
  const usage = active.attemptUsage;
  if (!usage || typeof usage !== 'object') return false;
  const output = ['completion_tokens', 'output_tokens', 'outputTokens']
    .map((key) => usage[key]).find((value) => Number.isSafeInteger(value) && value >= 0);
  return Number.isSafeInteger(output) && output >= limit;
}

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
