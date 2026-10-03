// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { estimateTokenValue } from './context-token-measurement.js';
import { ContractError } from '../ids.js';

/** Refresh older turns under measured pressure, or reduce a substantial tool payload. */
export const LONG_HORIZON_POLICY = Object.freeze({
  completedTurns: 8, toolPayloadRatio: 0.10,
});

export function longHorizonCompressionTrigger(records, options = {}) {
  if (!Array.isArray(records)) throw invalidRecords();
  const checkpoint = latestCheckpoint(records);
  if (checkpoint && checkpointDrifted(checkpoint.record)) return trigger('stale_continuation_artifact', checkpoint.index, records);
  const tail = checkpoint ? records.slice(checkpoint.index + 1) : records;
  const completedTurns = countCompletedTurns(tail, options.activeTurnId);
  const effectiveInputTokens = Number(options.effectiveInputTokens);
  const refreshThreshold = Number(options.refreshThreshold ?? 0.40);
  if (!Number.isFinite(refreshThreshold) || refreshThreshold <= 0 || refreshThreshold > 1) {
    throw new ContractError('long_horizon_options_invalid', 'refresh pressure threshold must be between zero and one');
  }
  const inputTokens = Number(options.estimatedInputTokens);
  if (completedTurns >= LONG_HORIZON_POLICY.completedTurns
    && effectiveInputTokens > 0 && inputTokens >= effectiveInputTokens * refreshThreshold) {
    return trigger('completed_turn_interval', checkpoint?.index ?? -1, records, { completedTurns });
  }
  const payloadTokens = tail.filter((record) => record.type === 'tool_result')
    .reduce((sum, record) => sum + estimateTokenValue(record.content ?? ''), 0);
  if (payloadTokens > 0 && effectiveInputTokens > 0
    && payloadTokens >= Math.max(1, Math.floor(effectiveInputTokens * LONG_HORIZON_POLICY.toolPayloadRatio))) {
    return trigger('tool_payload_budget', checkpoint?.index ?? -1, records, { payloadTokens, effectiveInputTokens });
  }
  return null;
}

export function retainedRecordsFingerprint(records) {
  if (!Array.isArray(records)) throw invalidRecords();
  try { return createHash('sha256').update(JSON.stringify(records)).digest('hex'); }
  catch (error) {
    const failure = invalidRecords(); failure.cause = error; throw failure;
  }
}

function latestCheckpoint(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.type === 'compaction') return { index, record: records[index] };
  }
  return null;
}

function checkpointDrifted(record) {
  if (!Array.isArray(record.retainedRecords) || !record.projection?.retainedFingerprint) return false;
  return retainedRecordsFingerprint(record.retainedRecords) !== record.projection.retainedFingerprint;
}

function countCompletedTurns(records, activeTurnId) {
  const turns = new Set();
  let legacy = 0;
  const hasActiveTurn = typeof activeTurnId === 'string' && activeTurnId.length > 0;
  for (const record of records) {
    if (record.type !== 'message' || record.role !== 'user') continue;
    const turnId = record.turnId ?? record.turn_id;
    if (turnId && (!hasActiveTurn || turnId !== activeTurnId)) turns.add(turnId);
    else if (!turnId) { legacy += 1; turns.add(`legacy:${legacy}`); }
  }
  return turns.size;
}

function invalidRecords() {
  return new ContractError('long_horizon_records_invalid', 'long-horizon context records must be a serializable array');
}

function trigger(reason, checkpointIndex, records, detail = {}) {
  return Object.freeze({ reason, checkpointIndex, tailRecords: records.length - checkpointIndex - 1, ...detail });
}
