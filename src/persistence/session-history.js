// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_RESTORED_RECORDS = 1_000_000;
const TRANSCRIPT_RECORD_TYPES = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);
const MISSION_RECORD_TYPES = new Set(['mission_turn_authorized', 'mission_tool_calls_reserved']);
const AUTHORITY_CONTROL_TYPES = new Set(['authority_intent', 'conversation_cleared', ...MISSION_RECORD_TYPES]);

// Security: when the caller supplies a genesis-anchored control stream, authority and
// mission budgets replay exclusively from it. Tail records then certify transcript
// fidelity only, so a truncated transcript window can neither drop nor invent authority.
export function restoreSessionRecords(records, options = {}) {
  const maxRecords = options.maxRecords ?? MAX_RESTORED_RECORDS;
  const control = assertControlStream(options.controlRecords === undefined ? null : options.controlRecords);
  assertRecordBounds(records, maxRecords);
  const transcript = [];
  const steering = new Map();
  const activeTurns = new Set();
  const interruptedTurns = new Set();
  const authority = [];
  const missionTurns = [];
  let workspaceRoot = null;
  let authorityReset = false;
  for (const record of records.slice(0, maxRecords)) {
    validateRecord(record);
    if (TRANSCRIPT_RECORD_TYPES.has(record.type)) {
      transcript.push(record.payload);
    } else if (record.type === 'compaction_snapshot') {
      transcript.splice(0, transcript.length, ...record.payload.records, record.payload.fact);
    } else if (record.type === 'conversation_cleared') {
      transcript.length = 0;
      if (control === null) {
        authority.length = 0;
        authorityReset = true;
      }
    } else if (record.type === 'authority_intent') {
      if (control === null) authority.push(record.payload);
    } else if (MISSION_RECORD_TYPES.has(record.type)) {
      if (control === null) missionTurns.push(record.payload);
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
    } else if (record.type === 'workspace_changed') {
      workspaceRoot = validatedWorkspaceRoot(record.payload);
    }
  }
  let authorityOutcome = { authorityReset };
  if (control !== null) authorityOutcome = replayAuthorityControl(control, authority, missionTurns);
  return Object.freeze({
    transcript: Object.freeze(transcript),
    steering: Object.freeze([...steering.values()]),
    authority: Object.freeze(authority),
    authorityReset: authorityOutcome.authorityReset,
    missionTurns: Object.freeze(missionTurns),
    interrupted: Object.freeze([...activeTurns].filter((id) => !interruptedTurns.has(id))),
    workspaceRoot,
  });
}

// Security: mission budget facts deliberately survive a clear boundary; only
// conversational authority is cut at the reset.
function replayAuthorityControl(control, authority, missionTurns) {
  authority.length = 0;
  missionTurns.length = 0;
  let authorityReset = false;
  for (const record of control) {
    validateRecord(record);
    if (!AUTHORITY_CONTROL_TYPES.has(record.type)) {
      throw new ContractError('session_history_invalid', 'authority control record type is invalid');
    }
    if (record.type === 'conversation_cleared') {
      authority.length = 0;
      authorityReset = true;
    } else if (record.type === 'authority_intent') {
      authority.push(record.payload);
    } else {
      missionTurns.push(record.payload);
    }
  }
  return { authorityReset };
}

function validatedWorkspaceRoot(payload) {
  if (typeof payload.workspaceRoot !== 'string' || payload.workspaceRoot.length === 0
    || payload.workspaceRoot.length > 4096) {
    throw new ContractError('session_history_invalid', 'working directory recovery record is invalid');
  }
  return payload.workspaceRoot;
}

function assertRecordBounds(records, maxRecords) {
  if (!Array.isArray(records) || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RESTORED_RECORDS) {
    throw new ContractError('session_history_invalid', 'session history requires a bounded record array');
  }
}

function assertControlStream(control) {
  if (control !== null && (!Array.isArray(control) || control.length > MAX_RESTORED_RECORDS)) {
    throw new ContractError('session_history_invalid', 'authority control recovery requires a bounded record array');
  }
  return control;
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
