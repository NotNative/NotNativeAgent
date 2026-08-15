// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

const TRANSCRIPT_RECORDS = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);

export async function persistEngineRecord(engine, type, payload) {
  validatePersistence(engine, type);
  const spanId = newId('persistence');
  const started = process.hrtime.bigint();
  const correlation = {
    spanId, turnId: payload?.turnId ?? payload?.turn_id ?? engine.active?.turnId,
    stepId: payload?.stepId ?? payload?.step_id ?? engine.active?.stepId,
    attemptId: payload?.attemptId ?? payload?.attempt_id ?? engine.active?.attemptId,
    toolRequestId: payload?.toolRequestId ?? payload?.tool_request_id,
  };
  safeTelemetry(engine, 'started', { record_type: type }, correlation);
  try {
    if (engine.store) await engine.store.append(type, payload);
    if (TRANSCRIPT_RECORDS.has(type)) engine.transcript.push(payload);
    safeTelemetry(engine, 'succeeded', { record_type: type }, {
      ...correlation, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    });
  } catch (error) {
    safeTelemetry(engine, 'failed', { record_type: type, code: error.code ?? 'persistence_failed' }, {
      ...correlation, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      reasonCode: error.code ?? 'persistence_failed',
    });
    throw error;
  }
}

function validatePersistence(engine, type) {
  if (!engine || typeof engine !== 'object' || typeof type !== 'string' || !type
    || (TRANSCRIPT_RECORDS.has(type) && !Array.isArray(engine.transcript))
    || (engine.store && typeof engine.store.append !== 'function')) {
    throw new ContractError('persistence_contract_invalid', 'engine persistence requires valid runtime state and record type');
  }
}

function safeTelemetry(engine, status, detail, correlation) {
  try { engine.telemetry?.record('persistence.record', status, detail, correlation); }
  catch { /* Telemetry is observational and cannot replace a persistence outcome. */ }
}
