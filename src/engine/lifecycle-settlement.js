// SPDX-License-Identifier: Apache-2.0
import { emitCurrentContextUsage } from './context-status.js';
import { ContractError } from '../ids.js';

export async function settleEngineChildren(engine, active, outcome, publish) {
  validateSettlement(engine, active, publish);
  const failures = [];
  if (active.attemptId) await settleEngineAttempt(engine, active, outcome, publish)
    .catch((error) => failures.push(error));
  if (active.stepId) await settleEngineStep(engine, active, outcome, publish)
    .catch((error) => failures.push(error));
  if (failures.length > 0) throw new AggregateError(failures, 'child finalization failed');
}

function validateSettlement(engine, active, publish) {
  if (!engine?.lifecycles || !active || typeof active !== 'object' || typeof publish !== 'function') {
    throw new ContractError('engine_settlement_invalid', 'engine child settlement requires lifecycle state and a publisher');
  }
}

export async function settleEngineAttempt(engine, active, outcome, publish) {
  const attemptId = active.attemptId;
  if (attemptId === null || attemptId === undefined) return;
  active.attemptId = null;
  engine.lifecycles.finish(attemptId, outcome);
  await publish('provider_attempt.terminal', 'provider_attempt', 'terminal', {
    ...active, attemptId,
  }, outcome);
}

export async function settleEngineStep(engine, active, outcome, publish) {
  const stepId = active.stepId;
  if (stepId === null || stepId === undefined) return;
  active.stepId = null;
  engine.lifecycles.finish(stepId, outcome);
  await publish('model_step.terminal', 'model_step', 'terminal', {
    ...active, stepId,
  }, outcome);
  await emitCurrentContextUsage(engine, active, stepId);
}
