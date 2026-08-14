// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';

const TRANSCRIPT_RECORDS = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);

export async function persistEngineRecord(engine, type, payload) {
  const spanId = newId('persistence');
  const started = process.hrtime.bigint();
  const correlation = {
    spanId, turnId: payload?.turnId ?? payload?.turn_id ?? engine.active?.turnId,
    stepId: payload?.stepId ?? payload?.step_id ?? engine.active?.stepId,
    attemptId: payload?.attemptId ?? payload?.attempt_id ?? engine.active?.attemptId,
    toolRequestId: payload?.toolRequestId ?? payload?.tool_request_id,
  };
  engine.telemetry.record('persistence.record', 'started', { record_type: type, payload }, correlation);
  try {
    if (TRANSCRIPT_RECORDS.has(type)) engine.transcript.push(payload);
    if (engine.store) await engine.store.append(type, payload);
    engine.telemetry.record('persistence.record', 'succeeded', { record_type: type }, {
      ...correlation, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    });
  } catch (error) {
    engine.telemetry.record('persistence.record', 'failed', { record_type: type, code: error.code ?? 'persistence_failed' }, {
      ...correlation, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      reasonCode: error.code ?? 'persistence_failed',
    });
    throw error;
  }
}
