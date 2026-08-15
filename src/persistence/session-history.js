// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_RESTORED_RECORDS = 1_000_000;
const TRANSCRIPT_RECORD_TYPES = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);
const MISSION_RECORD_TYPES = new Set(['mission_turn_authorized', 'mission_tool_calls_reserved']);

export function restoreSessionRecords(records, maxRecords = MAX_RESTORED_RECORDS) {
  if (!Array.isArray(records) || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RESTORED_RECORDS) {
    throw new ContractError('session_history_invalid', 'session history requires a bounded record array');
  }
  const transcript = [];
  const steering = new Map();
  const activeTurns = new Set();
  const interruptedTurns = new Set();
  const authority = [];
  const missionTurns = [];
  let authorityReset = false;
  for (const record of records.slice(0, maxRecords)) {
    validateRecord(record);
    if (TRANSCRIPT_RECORD_TYPES.has(record.type)) {
      transcript.push(record.payload);
    } else if (record.type === 'compaction_snapshot') {
      transcript.splice(0, transcript.length, ...record.payload.records, record.payload.fact);
    } else if (record.type === 'conversation_cleared') {
      transcript.length = 0;
      authority.length = 0;
      authorityReset = true;
    } else if (record.type === 'authority_intent') {
      authority.push(record.payload);
    } else if (MISSION_RECORD_TYPES.has(record.type)) {
      missionTurns.push(record.payload);
    } else if (record.type === 'turn_accepted') {
      activeTurns.add(recordTurnId(record.payload));
    } else if (record.type === 'turn_outcome') {
      activeTurns.delete(recordTurnId(record.payload));
      transcript.push({ ...record.payload, type: 'turn_outcome' });
    } else if (record.type === 'turn_interrupted') {
      const turnId = recordTurnId(record.payload);
      activeTurns.delete(turnId);
      interruptedTurns.add(turnId);
    } else if (record.type === 'steering_accepted') {
      steering.set(record.payload.id, record.payload);
    } else if (record.type === 'steering_consumed') {
      steering.delete(record.payload.id);
      transcript.push(record.payload.message);
    }
  }
  return Object.freeze({
    transcript: Object.freeze(transcript),
    steering: Object.freeze([...steering.values()]),
    authority: Object.freeze(authority),
    authorityReset,
    missionTurns: Object.freeze(missionTurns),
    interrupted: Object.freeze([...activeTurns].filter((id) => !interruptedTurns.has(id))),
  });
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.type !== 'string' || !record.payload || typeof record.payload !== 'object'
    || Array.isArray(record.payload)) {
    throw new ContractError('session_history_invalid', 'session history contains a malformed record');
  }
}

function recordTurnId(payload) {
  const turnId = payload.turnId ?? payload.turn_id;
  if (typeof turnId !== 'string' || turnId.length === 0) {
    throw new ContractError('session_history_invalid', 'session history turn record has no valid identity');
  }
  return turnId;
}
