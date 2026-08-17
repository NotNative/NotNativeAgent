// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';

/** Trigger after twelve settled turns or when tool output consumes ten percent of usable input. */
export const LONG_HORIZON_POLICY = Object.freeze({
  completedTurns: 12, toolPayloadRatio: 0.10, estimatedBytesPerToken: 4,
});

export function longHorizonCompressionTrigger(records, options = {}) {
  if (!Array.isArray(records)) throw invalidRecords();
  const checkpoint = latestCheckpoint(records);
  if (checkpoint && checkpointDrifted(checkpoint.record)) return trigger('stale_continuation_artifact', checkpoint.index, records);
  const tail = checkpoint ? records.slice(checkpoint.index + 1) : records;
  const completedTurns = countCompletedTurns(tail, options.activeTurnId);
  if (completedTurns >= LONG_HORIZON_POLICY.completedTurns) {
    return trigger('completed_turn_interval', checkpoint?.index ?? -1, records, { completedTurns });
  }
  const payloadBytes = toolPayloadBytes(tail);
  const effectiveInputTokens = Number(options.effectiveInputTokens);
  // Four UTF-8 bytes per token is a conservative tokenizer-free default; measured runtimes may override it.
  const estimatedBytesPerToken = Number(options.estimatedBytesPerToken ?? LONG_HORIZON_POLICY.estimatedBytesPerToken);
  if (!Number.isFinite(estimatedBytesPerToken) || estimatedBytesPerToken <= 0) {
    throw new ContractError('long_horizon_options_invalid', 'estimated bytes per token must be positive');
  }
  const inputBytes = Number.isFinite(effectiveInputTokens) && effectiveInputTokens > 0
    ? effectiveInputTokens * estimatedBytesPerToken : null;
  if (payloadBytes > 0 && inputBytes
    && payloadBytes >= Math.max(1, Math.floor(inputBytes * LONG_HORIZON_POLICY.toolPayloadRatio))) {
    return trigger('tool_payload_budget', checkpoint?.index ?? -1, records, { payloadBytes, inputBytes });
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

function toolPayloadBytes(records) {
  return records.filter((record) => record.type === 'tool_result')
    .reduce((sum, record) => sum + contentBytes(record.content), 0);
}

function contentBytes(content) {
  if (content === undefined || content === null) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(content), 'utf8'); }
  catch (error) { const failure = invalidRecords(); failure.cause = error; throw failure; }
}

function invalidRecords() {
  return new ContractError('long_horizon_records_invalid', 'long-horizon context records must be a serializable array');
}

function trigger(reason, checkpointIndex, records, detail = {}) {
  return Object.freeze({ reason, checkpointIndex, tailRecords: records.length - checkpointIndex - 1, ...detail });
}
