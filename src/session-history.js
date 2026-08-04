// SPDX-License-Identifier: Apache-2.0

export function restoreSessionRecords(records, maxRecords = 1_000_000) {
  const transcript = [];
  const steering = new Map();
  const activeTurns = new Set();
  const interruptedTurns = new Set();
  const authority = [];
  const missionTurns = [];
  let authorityReset = false;
  for (const record of records.slice(0, maxRecords)) {
    if (['message', 'tool_request', 'tool_result', 'compaction', 'attachment_fact'].includes(record.type)) {
      transcript.push(record.payload);
    } else if (record.type === 'compaction_snapshot') {
      transcript.splice(0, transcript.length, ...record.payload.records, record.payload.fact);
    } else if (record.type === 'conversation_cleared') {
      transcript.length = 0;
      authority.length = 0;
      authorityReset = true;
    } else if (record.type === 'authority_intent') {
      authority.push(record.payload);
    } else if (['mission_turn_authorized', 'mission_tool_calls_reserved'].includes(record.type)) {
      missionTurns.push(record.payload);
    } else if (record.type === 'turn_accepted') {
      activeTurns.add(record.payload.turnId);
    } else if (record.type === 'turn_outcome') {
      activeTurns.delete(record.payload.turn_id);
      transcript.push({ ...record.payload, type: 'turn_outcome' });
    } else if (record.type === 'turn_interrupted') {
      activeTurns.delete(record.payload.turnId);
      interruptedTurns.add(record.payload.turnId);
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
