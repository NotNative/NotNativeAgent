// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_RESTORED_RECORDS = 1_000_000;
const TRANSCRIPT_RECORD_TYPES = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact']);
const MISSION_RECORD_TYPES = new Set(['mission_turn_authorized', 'mission_tool_calls_reserved']);
const AUTHORITY_CONTROL_TYPES = new Set([
  'authority_intent', 'steering_consumed', 'conversation_cleared', ...MISSION_RECORD_TYPES,
  'steering_accepted', 'steering_abandoned', 'turn_outcome',
  'revert_point', 'revert_cleared',
]);
const TURN_LINKED_TYPES = new Set([...TRANSCRIPT_RECORD_TYPES, 'turn_accepted', 'turn_outcome', 'turn_interrupted']);
const TURN_BOUNDARY_TYPES = new Set(['turn_accepted', 'turn_outcome', 'turn_interrupted']);
const STEERING_RECORD_TYPES = new Set(['steering_accepted', 'steering_consumed', 'steering_abandoned']);

// Security: when the caller supplies a genesis-anchored control stream, authority and
// mission budgets replay exclusively from it. Tail records then certify transcript
// fidelity only, so a truncated transcript window can neither drop nor invent authority.
export function restoreSessionRecords(records, options = {}) {
  const maxRecords = options.maxRecords ?? MAX_RESTORED_RECORDS;
  const control = assertControlStream(options.controlRecords === undefined ? null : options.controlRecords);
  assertRecordBounds(records, maxRecords);
  const transcript = [];
  const steering = new Map();
  const activeTurns = new Set(), interruptedTurns = new Set();
  const authority = [], missionTurns = [];
  const hidden = hiddenTurnIds(control ?? records);
  const terminalTurns = terminalTurnIds(records);
  let hiddenSourceSeen = false;
  let workspaceRoot = null, latestTurnOutcome = null, authorityReset = false;
  for (const record of records.slice(0, maxRecords)) {
    validateRecord(record);
    if (record.type === 'revert_point') { hiddenSourceSeen = false; continue; }
    if (record.type === 'revert_cleared') continue;
    const linkedTurnId = record.payload?.turnId ?? record.payload?.turn_id;
    if (TURN_LINKED_TYPES.has(record.type) && typeof linkedTurnId === 'string' && hidden.has(linkedTurnId)) {
      hiddenSourceSeen = true;
      continue;
    }
    if (TRANSCRIPT_RECORD_TYPES.has(record.type)) {
      // A compaction fact can summarize a reverted turn without carrying its ID.
      if (record.type !== 'compaction' || !hiddenSourceSeen) transcript.push(record.payload);
    } else if (record.type === 'compaction_snapshot') {
      // Invariant: a snapshot is a transcript source, so it obeys the same
      // effective revert timeline as later journal records.
      const snapshot = visibleSnapshotRecords(record.payload, hidden, hiddenSourceSeen);
      hiddenSourceSeen = snapshot.hiddenSourceSeen;
      transcript.splice(0, transcript.length, ...snapshot.visible);
    } else if (record.type === 'conversation_cleared') {
      transcript.length = 0;
      latestTurnOutcome = null;
      hiddenSourceSeen = false;
      if (control === null) { authority.length = 0; authorityReset = true; }
    } else if (record.type === 'authority_intent') {
      if (control === null) authority.push(record.payload);
    } else if (MISSION_RECORD_TYPES.has(record.type)) {
      if (control === null) missionTurns.push(record.payload);
    } else if (TURN_BOUNDARY_TYPES.has(record.type)) {
      const outcome = replayTurnBoundary(record, activeTurns, interruptedTurns, transcript);
      if (outcome) latestTurnOutcome = outcome;
    } else if (STEERING_RECORD_TYPES.has(record.type)) {
      replaySteeringRecord(record, { steering, transcript, authority, control, terminalTurns, hidden });
    } else if (record.type === 'workspace_changed') { workspaceRoot = validatedWorkspaceRoot(record.payload); }
  }
  let authorityOutcome = { authorityReset };
  if (control !== null) authorityOutcome = replayAuthorityControl(control, authority, missionTurns);
  const pendingSteering = pendingSteeringForReplay(control, options, steering, activeTurns, hidden);
  return Object.freeze({
    transcript: Object.freeze(transcript),
    latestTurnOutcome,
    steering: Object.freeze(pendingSteering),
    authority: Object.freeze(authority),
    authorityReset: authorityOutcome.authorityReset,
    missionTurns: Object.freeze(missionTurns),
    interrupted: Object.freeze([...activeTurns].filter((id) => !interruptedTurns.has(id))),
    workspaceRoot,
  });
}

function replaySteeringRecord(record, state) {
  const { steering, transcript, authority, control, terminalTurns, hidden } = state;
  if (record.type === 'steering_accepted') {
    if (!hidden.has(record.payload.turnId) && !terminalTurns.has(record.payload.turnId)) {
      steering.set(record.payload.id, record.payload);
    }
  } else if (record.type === 'steering_consumed') {
    if (hidden.has(record.payload.message?.turnId)) return;
    steering.delete(record.payload.id);
    transcript.push(record.payload.message);
    if (control === null && record.payload.intent) authority.push(record.payload.intent);
  } else steering.delete(record.payload.id);
}

function visibleSnapshotRecords(payload, hidden, hiddenSourceSeen) {
  const visible = [];
  for (const item of payload.records) {
    if (hidden.has(item?.turnId ?? item?.turn_id)) {
      hiddenSourceSeen = true;
    } else if (item?.type !== 'compaction' || !hiddenSourceSeen) {
      visible.push(item);
    }
  }
  if (!hiddenSourceSeen && !hidden.has(payload.fact?.turnId ?? payload.fact?.turn_id)) visible.push(payload.fact);
  return { visible, hiddenSourceSeen };
}

function terminalTurnIds(records) {
  return new Set(records.filter((record) => record.type === 'turn_outcome')
    .map((record) => record.payload?.turnId ?? record.payload?.turn_id).filter((id) => typeof id === 'string'));
}

function replayTurnBoundary(record, activeTurns, interruptedTurns, transcript) {
  const turnId = recordTurnId(record.payload);
  if (record.type === 'turn_accepted') activeTurns.add(turnId);
  else activeTurns.delete(turnId);
  if (record.type === 'turn_interrupted') interruptedTurns.add(turnId);
  if (record.type !== 'turn_outcome') return null;
  const outcome = { ...record.payload, type: 'turn_outcome' };
  transcript.push(outcome);
  return outcome;
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
    } else if (record.type === 'steering_consumed') {
      if (record.payload.intent) authority.push(record.payload.intent);
    } else if (MISSION_RECORD_TYPES.has(record.type)) {
      missionTurns.push(record.payload);
    }
  }
  return { authorityReset };
}

function replaySteeringControl(control, hidden) {
  const pending = new Map();
  const terminal = new Set();
  for (const record of control) {
    if (record.type === 'conversation_cleared') {
      pending.clear();
    } else if (record.type === 'turn_outcome') {
      const turnId = recordTurnId(record.payload);
      terminal.add(turnId);
      for (const [id, item] of pending) if (item.turnId === turnId) pending.delete(id);
    } else if (record.type === 'steering_accepted') {
      const item = record.payload;
      if (!hidden.has(item.turnId) && !terminal.has(item.turnId)) pending.set(item.id, item);
    } else if (record.type === 'steering_consumed' || record.type === 'steering_abandoned') {
      pending.delete(record.payload.id);
    }
  }
  return [...pending.values()];
}

function pendingSteeringForReplay(control, options, steering, activeTurns, hidden) {
  // Security: pending steering requires the complete genesis-anchored control stream.
  // A partial scan or a tail without its original admission cannot prove eligibility.
  if (control === null) return [...steering.values()].filter((item) => activeTurns.has(item.turnId));
  if (options.controlComplete === false) return [];
  // Invariant: a revert point can precede the bounded transcript tail.
  return replaySteeringControl(control, hiddenTurnIds(control));
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

function revertedTurnIds(payload) {
  const ids = payload?.reverted_turn_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100_000
    || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ContractError('session_history_invalid', 'session revert point has no valid turn set');
  }
  return ids;
}

// Security: the pre-scan keeps replay order canonical — a turn submitted
// between a revert point and its clear replays after the restored turns.
function hiddenTurnIds(records) {
  const stack = [];
  const active = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.type === 'revert_point') {
      const ids = new Set(revertedTurnIds(record.payload));
      stack.push(ids);
      for (const id of ids) active.add(id);
    } else if (record?.type === 'revert_cleared') {
      for (const id of stack.pop() ?? []) active.delete(id);
    }
  }
  return active;
}
