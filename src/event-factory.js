// SPDX-License-Identifier: Apache-2.0
import { newId } from './ids.js';

export class EventFactory {
  #sequence = 0;

  constructor(runtimeId, sessionId) {
    this.runtimeId = runtimeId;
    this.sessionId = sessionId;
  }

  create(name, category, phase, correlation = {}, payload = {}, outcome = null) {
    this.#sequence += 1;
    return Object.freeze({
      schema_version: '1.0', event_id: newId('event'), event_name: name,
      timestamp: new Date().toISOString(), sequence: this.#sequence,
      runtime_id: this.runtimeId, session_id: this.sessionId,
      turn_id: correlation.turnId ?? null, step_id: correlation.stepId ?? null,
      attempt_id: correlation.attemptId ?? null,
      logical_request_id: correlation.logicalRequestId ?? null,
      tool_request_id: correlation.toolRequestId ?? null,
      category, phase, outcome, origin: correlation.origin ?? 'engine',
      privacy: Object.freeze({ payload: 'sensitive_content' }), payload,
    });
  }
}
