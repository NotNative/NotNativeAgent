// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

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
  // Some OpenAI-compatible providers omit a terminal finish reason for a
  // reasoning-only completion. Preserve native reasoning on the bounded retry;
  // the recovery hint, not a thinking-mode mutation, should steer it to action.
  return Object.freeze({ action: active.recovery.reasoningTruncated(), reasoningMode: 'preserve' });
}

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
