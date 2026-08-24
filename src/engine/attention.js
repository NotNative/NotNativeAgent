// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { assertTurnActive } from '../turn-cancellation.js';
import { emitEngineStatus, emitEngineText } from './output.js';

export async function awaitEngineAttention(engine, active, result, operations) {
  const detail = engine.reliability.exhaustionDetail(
    active.recovery, engine.transcript, active.unresolvedToolFailures, result,
  );
  const explanation = engine.reliability.exhaustionText(detail, {
    transcript: engine.transcript, turnId: active.turnId,
  });
  engine.state.transition('awaiting_attention', {
    trigger: result.category ?? 'recovery_exhausted', turnId: active.turnId,
  });
  await operations.persist('attention_required', {
    turnId: active.turnId, stepId: active.stepId,
    category: result.category ?? 'no_progress', count: result.count ?? null,
    detail, createdAt: new Date().toISOString(),
  });
  assertTurnActive(active);
  await emitEngineText(engine, explanation, active, 'recovery_attention');
  assertTurnActive(active);
  await emitEngineStatus(engine, 'attention_required', active);
  const waiter = attentionWaiter(active.controller.signal);
  active.attentionWaiter = waiter;
  if (engine.steering.length > 0) waiter.resolve('steering');
  try {
    await waiter.promise;
  } finally {
    waiter.dispose();
    if (active.attentionWaiter === waiter) active.attentionWaiter = null;
  }
  assertTurnActive(active);
  const consumed = await operations.consumeSteering(active);
  if (consumed.length === 0) {
    throw new ContractError('attention_resume_invalid', 'attention wait resumed without authenticated steering');
  }
  await operations.persist('attention_resumed', {
    turnId: active.turnId, stepId: active.stepId,
    category: result.category ?? 'no_progress', steeringIds: consumed,
    resumedAt: new Date().toISOString(),
  });
  engine.state.transition('preparing_continuation', {
    trigger: 'operator_attention_received', turnId: active.turnId,
  });
  await emitEngineStatus(engine, 'preparing', active);
  return 'Automatic recovery was parked after repeated no-progress behavior. Authenticated operator direction is now available in the conversation. Reassess from the last verified checkpoint, follow that direction, and do not repeat the unchanged action.';
}

function attentionWaiter(signal) {
  let resolve;
  let settled = false;
  const promise = new Promise((yes) => {
    resolve = (reason) => {
      if (settled) return false;
      settled = true;
      yes(reason);
      return true;
    };
  });
  const abort = () => resolve('abort');
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return Object.freeze({
    promise, resolve,
    dispose: () => signal.removeEventListener('abort', abort),
  });
}
