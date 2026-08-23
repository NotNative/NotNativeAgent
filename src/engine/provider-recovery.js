// SPDX-License-Identifier: Apache-2.0
import { settleEngineStep } from './lifecycle-settlement.js';

const RECOVERING_STATE = 'recovering';
const PREPARING_CONTINUATION_STATE = 'preparing_continuation';

// Session lifecycle adapter: the Reliability Engine decides; SessionEngine applies and records.
export async function recoverProviderContextLimit(engine, error, active, operations) {
  const plan = engine.reliability.providerContextLimit(active);
  await operations.settleAttempt('failed');
  const trigger = error?.code ?? 'provider_context_limit';
  engine.state.transition(RECOVERING_STATE, { trigger, turnId: active.turnId });
  if (plan.action) await operations.recordRecovery(plan.action);
  await operations.settleStep(plan.continue ? RECOVERING_STATE : 'failed');
  if (!plan.continue) throw error;
  active.contextRetryScale = plan.scale;
  engine.state.transition(PREPARING_CONTINUATION_STATE, { trigger, turnId: active.turnId });
  return { continue: true, forceCompact: true, hint: engine.reliability.hint(plan.action) };
}

export async function recoverReasoningOnly(engine, active) {
  const plan = engine.reliability.reasoningOnly(active);
  if (!plan) return null;
  active.reasoningHeadroomRetryUsed = true;
  active.reasoningFallbackUsed = false;
  active.reasoningFallbackPending = false;
  active.enrichment.reasoningRecoveryContinuation = Object.freeze({
    reasoningContent: active.stepReasoningText,
    providerProfile: active.providerResource,
    model: active.modelName,
  });
  await engine.providerRunner.settleAttempt(active, 'reasoning_truncated');
  const trigger = 'reasoning_truncated_before_action';
  engine.state.transition(RECOVERING_STATE, { trigger, turnId: active.turnId });
  await engine.providerRunner.recordRecovery(plan.action, active);
  await settleEngineStep(engine, active, RECOVERING_STATE, (...args) => engine.providerRunner.publish(...args));
  engine.state.transition(PREPARING_CONTINUATION_STATE, {
    trigger: 'retry_reasoning_to_action', turnId: active.turnId,
  });
  return { continue: true, hint: engine.reliability.hint(plan.action) };
}

export { contextPressureScale } from '../reliability/provider-recovery.js';

