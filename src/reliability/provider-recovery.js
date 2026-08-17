// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function providerContextLimitDecision(active) {
  const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
  const pressureScale = contextPressureScale(active.runtimeModel);
  const plan = active.recovery.contextLimit(partial, pressureScale);
  if (plan.continue && (!Number.isFinite(plan.scale) || plan.scale <= 0 || plan.scale > 1)) {
    throw new ContractError('context_recovery_invalid', 'context recovery produced an invalid pressure scale');
  }
  return plan;
}

export function reasoningOnlyDecision(active) {
  if (active.stepText.length > 0 || active.stepReasoningBytes === 0 || active.reasoningFallbackUsed) return null;
  return Object.freeze({ action: active.recovery.reasoningOnly(), reasoningMode: 'off' });
}

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
