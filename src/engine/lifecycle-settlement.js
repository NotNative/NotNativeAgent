// SPDX-License-Identifier: Apache-2.0
import { emitCurrentContextUsage } from './context-status.js';

export async function settleEngineChildren(engine, active, outcome, publish) {
  const failures = [];
  if (active.attemptId) await settleEngineAttempt(engine, active, outcome, publish)
    .catch((error) => failures.push(error));
  if (active.stepId) await settleEngineStep(engine, active, outcome, publish)
    .catch((error) => failures.push(error));
  if (failures.length > 0) throw new AggregateError(failures, 'child finalization failed');
}

export async function settleEngineAttempt(engine, active, outcome, publish) {
  engine.lifecycles.finish(active.attemptId, outcome);
  await publish('provider_attempt.terminal', 'provider_attempt', 'terminal', active, outcome);
  active.attemptId = null;
}

export async function settleEngineStep(engine, active, outcome, publish) {
  const stepId = active.stepId;
  engine.lifecycles.finish(stepId, outcome);
  await publish('model_step.terminal', 'model_step', 'terminal', active, outcome);
  active.stepId = null;
  await emitCurrentContextUsage(engine, active, stepId);
}
