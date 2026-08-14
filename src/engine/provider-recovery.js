// SPDX-License-Identifier: Apache-2.0
import { settleEngineStep } from './lifecycle-settlement.js';
import { recoveryHint } from '../recovery.js';

export async function recoverProviderContextLimit(engine, error, active, operations) {
  const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
  const pressureScale = contextPressureScale(active.runtimeModel);
  const plan = active.recovery.contextLimit(partial, pressureScale);
  await operations.settleAttempt('failed');
  engine.state.transition('recovering', { trigger: error.code, turnId: active.turnId });
  if (plan.action) await operations.recordRecovery(plan.action);
  await operations.settleStep(plan.continue ? 'recovering' : 'failed');
  if (!plan.continue) throw error;
  active.contextRetryScale = plan.scale;
  engine.state.transition('preparing_continuation', { trigger: error.code, turnId: active.turnId });
  return { continue: true, forceCompact: true, hint: operations.hint(plan.action) };
}

export async function recoverReasoningOnly(engine, active) {
  if (active.stepText.length > 0 || active.stepReasoningBytes === 0 || active.reasoningFallbackUsed) return null;
  active.reasoningFallbackUsed = true;
  active.reasoningFallbackPending = true;
  await engine.providerRunner.settleAttempt(active, 'reasoning_only');
  engine.state.transition('recovering', { trigger: 'reasoning_only_output', turnId: active.turnId });
  const action = active.recovery.reasoningOnly();
  await engine.providerRunner.recordRecovery(action, active);
  await settleEngineStep(engine, active, 'recovering', (...args) => engine.providerRunner.publish(...args));
  engine.state.transition('preparing_continuation', { trigger: 'retry_without_reasoning', turnId: active.turnId });
  return { continue: true, hint: recoveryHint(action) };
}

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
