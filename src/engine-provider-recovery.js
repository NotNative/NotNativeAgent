// SPDX-License-Identifier: Apache-2.0

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

export function contextPressureScale(runtime) {
  const parallel = Number.isInteger(runtime?.parallelCapacity)
    ? Math.max(1, runtime.parallelCapacity) : 1;
  return parallel > 1 ? Math.max(0.125, 1 / parallel) : 0.75;
}
