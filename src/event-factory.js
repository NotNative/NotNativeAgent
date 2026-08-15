// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';

const EVENT_SCHEMA_VERSION = '1.0';
const SENSITIVE_CONTENT_CLASSIFICATION = 'sensitive_content';
const ENGINE_ORIGIN = 'engine';

export class EventFactory {
  #sequence = 0;

  constructor(runtimeId, sessionId) {
    this.runtimeId = runtimeId;
    this.sessionId = sessionId;
  }

  create(name, category, phase, correlation = {}, payload = {}, outcome = null) {
    correlation ??= {};
    if (!correlation || typeof correlation !== 'object' || Array.isArray(correlation)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ContractError('event_contract_invalid', 'event correlation and payload must be objects');
    }
    const immutablePayload = deepFreeze(structuredClone(payload));
    this.#sequence += 1;
    return Object.freeze({
      schema_version: EVENT_SCHEMA_VERSION, event_id: newId('event'), event_name: name,
      timestamp: new Date().toISOString(), sequence: this.#sequence,
      runtime_id: this.runtimeId, session_id: this.sessionId,
      turn_id: correlation.turnId ?? null, step_id: correlation.stepId ?? null,
      attempt_id: correlation.attemptId ?? null,
      logical_request_id: correlation.logicalRequestId ?? null,
      tool_request_id: correlation.toolRequestId ?? null,
      category, phase, outcome, origin: correlation.origin ?? ENGINE_ORIGIN,
      privacy: Object.freeze({ payload: SENSITIVE_CONTENT_CLASSIFICATION }), payload: immutablePayload,
    });
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
