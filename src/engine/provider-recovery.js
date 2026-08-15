// SPDX-License-Identifier: Apache-2.0
import { settleEngineStep } from './lifecycle-settlement.js';
import { recoveryHint } from '../recovery.js';
import { ContractError } from '../ids.js';

const RECOVERING_STATE = 'recovering';
const PREPARING_CONTINUATION_STATE = 'preparing_continuation';
const REASONING_ONLY_TRIGGER = 'reasoning_only_output';
const RETRY_WITHOUT_REASONING_TRIGGER = 'retry_without_reasoning';

export async function recoverProviderContextLimit(engine, error, active, operations) {
  const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
  const pressureScale = contextPressureScale(active.runtimeModel);
  const plan = active.recovery.contextLimit(partial, pressureScale);
  await operations.settleAttempt('failed');
  const trigger = error?.code ?? 'provider_context_limit';
  engine.state.transition(RECOVERING_STATE, { trigger, turnId: active.turnId });
  if (plan.action) await operations.recordRecovery(plan.action);
  await operations.settleStep(plan.continue ? RECOVERING_STATE : 'failed');
  if (!plan.continue) throw error;
  if (!Number.isFinite(plan.scale) || plan.scale <= 0 || plan.scale > 1) {
    throw new ContractError('context_recovery_invalid', 'context recovery produced an invalid pressure scale');
  }
  active.contextRetryScale = plan.scale;
  engine.state.transition(PREPARING_CONTINUATION_STATE, { trigger, turnId: active.turnId });
  return { continue: true, forceCompact: true, hint: operations.hint(plan.action) };
}

export async function recoverReasoningOnly(engine, active) {
  if (active.stepText.length > 0 || active.stepReasoningBytes === 0 || active.reasoningFallbackUsed) return null;
  active.reasoningFallbackUsed = true;
  active.reasoningFallbackPending = true;
  await engine.providerRunner.settleAttempt(active, 'reasoning_only');
  engine.state.transition(RECOVERING_STATE, { trigger: REASONING_ONLY_TRIGGER, turnId: active.turnId });
  const action = active.recovery.reasoningOnly();
  await engine.providerRunner.recordRecovery(action, active);
  await settleEngineStep(engine, active, RECOVERING_STATE, (...args) => engine.providerRunner.publish(...args));
  engine.state.transition(PREPARING_CONTINUATION_STATE, { trigger: RETRY_WITHOUT_REASONING_TRIGGER, turnId: active.turnId });
  return { continue: true, hint: recoveryHint(action) };
}

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
