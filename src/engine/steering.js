// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

export async function steerEngineTurn(engine, command, principal) {
  const active = engine.active;
  if (!active || active.finalized) return { accepted: false, reason: 'no_active_turn' };
  if (engine.steering.length + active.steeringAdmissions >= engine.config.limits.maxSteering) {
    throw new ContractError('steering_capacity', 'steering queue is full');
  }
  // Invariant: reserve before the first await so concurrent admissions share one bound.
  if (active.steeringAdmissions === 0) {
    active.steeringAdmissionsDone = new Promise((resolve) => { active.steeringAdmissionsResolve = resolve; });
  }
  active.steeringAdmissions += 1;
  const record = Object.freeze({
    id: newId('steering'), requestId: command.request_id,
    content: command.content, principal, turnId: active.turnId,
    acceptedAt: new Date().toISOString(), consumed: false,
  });
  try {
    if (engine.store) await engine.store.append('steering_accepted', record);
    if (engine.active !== active || active.finalized) {
      // Compatibility: an admission racing terminal commit must never steer the next turn.
      if (engine.store) await engine.store.append('steering_abandoned', { id: record.id, turnId: record.turnId });
      return { accepted: false, reason: 'no_active_turn' };
    }
    engine.steering.push(record);
    try {
      // Why: a host status callback can remain pending indefinitely. A committed
      // admission must release its reservation and wake the turn independently.
      Promise.resolve(engine.output({
        version: '1.0', type: 'accepted', request_id: command.request_id,
        accepted: true, command_type: 'steer', steering_id: record.id,
        turn_id: active.turnId, session_id: engine.sessionId,
      })).catch(() => undefined);
    } catch {
      // The durable admission is authoritative even if its status display fails.
    }
    active.attentionWaiter?.resolve('steering');
    active.providerRecoveryWaiter?.resolve('steering');
    return { accepted: true, steering_id: record.id };
  } finally {
    active.steeringAdmissions -= 1;
    if (active.steeringAdmissions === 0) {
      active.steeringAdmissionsResolve();
      active.steeringAdmissionsResolve = null;
    }
  }
}
