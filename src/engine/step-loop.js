// SPDX-License-Identifier: Apache-2.0
import { awaitEngineAttention } from './attention.js';
import { applyPendingConfiguration } from '../runtime-config.js';
import { appendRecoveryHint } from '../context.js';

// Why: bound the model-step loop by wall-clock so a runaway continuation cannot spend
// unbounded time or tokens unattended. Always allow at least one step, then stop cleanly at
// a step boundary (never mid-stream), preserving committed work and recovery diagnostics.
export function turnWallClockReached(active, modelStepIndex, turnWallClockMs) {
  return Boolean(turnWallClockMs) && modelStepIndex >= 1
    && Date.now() - active.startedAt >= turnWallClockMs;
}

async function modelStepExhausted(engine, active, result, dependencies) {
  const attention = await awaitEngineAttention(engine, active, result, {
    persist: dependencies.persist, consumeSteering: dependencies.consumeSteering,
  });
  if (attention.terminal) {
    return dependencies.finalize('limit_reached', attention.explanation, attention.detail, { emitText: true });
  }
  applyPendingConfiguration(engine, active);
  let context = await dependencies.prepareContext(engine.transcript, '', active);
  context = appendRecoveryHint(context, attention.hint);
  return { continue: true, context };
}

function limitDetail(engine, active, category, count) {
  return engine.reliability.exhaustionDetail(active.recovery, engine.transcript, active.unresolvedToolFailures, {
    category, count,
  });
}

function limitText(engine, active, detail) {
  return engine.reliability.exhaustionText(detail, { transcript: engine.transcript, turnId: active.turnId });
}

export async function runModelStepLoop(engine, active, initialContext, dependencies) {
  const maxModelSteps = engine.config.limits.maxModelSteps;
  const turnWallClockMs = engine.config.limits.turnWallClockMs;
  let context = initialContext;
  let modelStepIndex = 0;
  while (modelStepIndex < maxModelSteps) {
    if (turnWallClockReached(active, modelStepIndex, turnWallClockMs)) {
      const detail = limitDetail(engine, active, 'turn_wall_clock_limit', modelStepIndex);
      return dependencies.finalize('limit_reached', limitText(engine, active, detail), detail, { emitText: true });
    }
    const result = await dependencies.runModelStep(context, active);
    if (result.countModelStep !== false) modelStepIndex += 1;
    if (result.exhausted) {
      const recovered = await modelStepExhausted(engine, active, result, dependencies);
      if (recovered.continue) { context = recovered.context; continue; }
      return recovered;
    }
    if (!result.continue) return dependencies.completeFromStep(result, active);
    applyPendingConfiguration(engine, active);
    context = await dependencies.prepareContext(engine.transcript, '', active, result.forceCompact);
    context = appendRecoveryHint(context, result.hint);
  }
  const detail = limitDetail(engine, active, 'model_step_limit', maxModelSteps);
  return dependencies.finalize('limit_reached', limitText(engine, active, detail), detail, { emitText: true });
}
