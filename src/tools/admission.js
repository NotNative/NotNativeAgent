// SPDX-License-Identifier: Apache-2.0
import { assertMissionBudget, reserveAndPersistMissionTools } from '../authority.js';

export async function reserveToolAdmission(engine, active, items, persist) {
  const admitted = items.filter((item) => item.request).length;
  assertMissionBudget(active, admitted);
  // Invariant: only validated new requests consume budget; durable reservation still precedes review and effects.
  active.authority = await reserveAndPersistMissionTools(
    engine.authority, engine.config, admitted, (record) => persist('mission_tool_calls_reserved', record),
  );
  engine.telemetry?.record('tool.admission', 'succeeded', {
    attempted_calls: items.length, admitted_calls: admitted,
    invalid_calls: items.filter((item) => item.result?.status === 'invalid_request').length,
    reused_calls: items.filter((item) => item.duplicate).length,
    reserved_tool_calls: active.authority?.mission?.usage.toolCalls ?? null,
  }, { turnId: active.turnId, stepId: active.stepId });
}
