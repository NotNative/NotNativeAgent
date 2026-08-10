// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export const LONG_HORIZON_POLICY = Object.freeze({
  completedTurns: 12, toolPayloadRatio: 0.10,
});

export function longHorizonCompressionTrigger(records, options = {}) {
  const checkpoint = latestCheckpoint(records);
  if (checkpoint && checkpointDrifted(checkpoint.record)) return trigger('stale_continuation_artifact', checkpoint.index, records);
  const tail = checkpoint ? records.slice(checkpoint.index + 1) : records;
  const completedTurns = countCompletedTurns(tail, options.activeTurnId);
  if (completedTurns >= LONG_HORIZON_POLICY.completedTurns) {
    return trigger('completed_turn_interval', checkpoint?.index ?? -1, records, { completedTurns });
  }
  const payloadBytes = toolPayloadBytes(tail);
  const effectiveInputTokens = Number(options.effectiveInputTokens);
  const inputBytes = Number.isFinite(effectiveInputTokens) && effectiveInputTokens > 0
    ? effectiveInputTokens * 4 : null;
  if (payloadBytes > 0 && inputBytes
    && payloadBytes >= Math.max(1, Math.floor(inputBytes * LONG_HORIZON_POLICY.toolPayloadRatio))) {
    return trigger('tool_payload_budget', checkpoint?.index ?? -1, records, { payloadBytes, inputBytes });
  }
  return null;
}

export function retainedRecordsFingerprint(records) {
  return createHash('sha256').update(JSON.stringify(records ?? [])).digest('hex');
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
  const turns = new Set(); let legacy = 0;
  for (const record of records) {
    if (record.type !== 'message' || record.role !== 'user') continue;
    const turnId = record.turnId ?? record.turn_id;
    if (turnId && turnId !== activeTurnId) turns.add(turnId);
    else if (!turnId) { legacy += 1; turns.add(`legacy:${legacy}`); }
  }
  return turns.size;
}

function toolPayloadBytes(records) {
  return records.filter((record) => record.type === 'tool_result')
    .reduce((sum, record) => sum + Buffer.byteLength(String(record.content ?? ''), 'utf8'), 0);
}

function trigger(reason, checkpointIndex, records, detail = {}) {
  return Object.freeze({ reason, checkpointIndex, tailRecords: records.length - checkpointIndex - 1, ...detail });
}
