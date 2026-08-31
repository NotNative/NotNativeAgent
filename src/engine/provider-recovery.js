// SPDX-License-Identifier: Apache-2.0
import { settleEngineStep } from './lifecycle-settlement.js';
import { assertTurnActive } from '../turn-cancellation.js';

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

export async function recoverContentFreeCompletion(engine, active, operations) {
  await operations.settleAttempt('empty');
  engine.state.transition(RECOVERING_STATE, {
    trigger: 'provider_unusable_completion', turnId: active.turnId,
  });
  const receipt = active.tokenReceipts.at(-1);
  const routeIdentity = `${active.providerResource}\0${active.modelName}`;
  const plan = engine.reliability.providerUnusableCompletion(active, {
    event_shape: receipt?.event_shape ?? null,
    reported_output_tokens: receipt?.reported_usage?.output_tokens ?? null,
  }, { routeIdentity });
  if (plan.action) await operations.recordRecovery(plan.action);
  await operations.settleStep(RECOVERING_STATE);
  let waitOutcome = 'steering';
  if (engine.steering.length === 0) {
    const provider = active.providerRoute ? engine.router.provider(active.providerRoute) : null;
    waitOutcome = await engine.providerRunner.waitForProviderRecovery(provider, active, plan.delayMs);
  }
  assertTurnActive(active);
  if (waitOutcome === 'steering' || engine.steering.length > 0) await operations.consumeSteering();
  engine.state.transition(PREPARING_CONTINUATION_STATE, {
    trigger: 'provider_completion_recovery', turnId: active.turnId,
  });
  return { continue: true, hint: engine.reliability.hint(plan.action), countModelStep: false };
}

export { contextPressureScale } from '../reliability/provider-recovery.js';
