// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { presentedToolTarget } from '../engine/records.js';

const RECORD = Object.freeze({ message: 'message', outcome: 'turn_outcome' });
const ROLE = Object.freeze({ assistant: 'assistant', user: 'user' });
const EVENT = Object.freeze({ input: 'user_input', delta: 'stream_delta', result: 'turn_result' });

export function restoreTranscript(projection, sessionId, transcript) {
  for (const event of transcriptEvents(transcript)) projection.apply(sessionId, event);
}

export function restoreDurablePresentation(projection, sessionId, journalRecords, transcript, options = {}) {
  const events = Array.isArray(journalRecords) && journalRecords.length > 0
    ? journalEvents(journalRecords, options) : transcriptEvents(transcript);
  for (const event of events) projection.apply(sessionId, event);
}

export function journalEvents(records, options = {}) {
  if (!Array.isArray(records)) throw new ContractError('transcript_invalid', 'saved journal must be an array');
  const source = presentationSource(records, options.truncated === true);
  const requests = new Map();
  const committedCandidates = committedCandidateKeys(source);
  const events = [];
  for (const record of source) {
    validateJournalRecord(record);
    const item = record.payload;
    if (record.type === 'conversation_cleared') { events.length = 0; requests.clear(); continue; }
    if (record.type === 'tool_request') {
      requests.set(item.requestId ?? item.providerCallId, item);
      if (item.providerCallId) requests.set(item.providerCallId, item);
      continue;
    }
    if (record.type === 'message') appendMessageEvent(events, item);
    else if (record.type === 'steering_consumed') appendMessageEvent(events, item.message);
    else if (record.type === 'response_candidate' && !committedCandidates.has(candidateKey(item))) {
      events.push({ type: EVENT.delta, turn_id: turnIdentity(item), text: item.content,
        historical_message: true, provisional: true });
    } else if (record.type === 'tool_result') events.push(historicalToolEvent(item, requests));
    else if (record.type === 'turn_outcome') events.push({ ...item, type: EVENT.result, turn_id: turnIdentity(item) });
    else if (record.type === 'turn_interrupted') events.push(interruptedTurnEvent(item));
    else if (record.type === 'compaction') events.push(compactionEvent(item));
    else if (record.type === 'compaction_snapshot') events.push(compactionEvent(item.fact));
  }
  return events;
}

export function transcriptEvents(transcript) {
  if (!Array.isArray(transcript)) {
    throw new ContractError('transcript_invalid', 'saved transcript must be an array');
  }
  const lastAssistant = new Map();
  const terminalTurns = new Set();
  for (const [index, item] of transcript.entries()) {
    validateTranscriptItem(item);
    const turnId = turnIdentity(item);
    if (item.type === RECORD.message && item.role === ROLE.assistant && turnId) {
      lastAssistant.set(turnId, index);
    }
    if (item.type === RECORD.outcome && turnId) terminalTurns.add(turnId);
  }
  const events = [];
  for (const [index, item] of transcript.entries()) {
    const turnId = turnIdentity(item);
    if (item.type === RECORD.outcome) {
      events.push({ ...item, type: EVENT.result, turn_id: turnId });
      continue;
    }
    if (item.type !== RECORD.message) continue;
    if (item.role === ROLE.user) events.push({ type: EVENT.input, text: item.content });
    else if (item.role === ROLE.assistant) {
      // Why: every durable assistant message is a completed response segment. Marking the
      // boundary prevents rehydration from merging tool-separated messages into one lifeless block.
      events.push({ type: EVENT.delta, turn_id: turnId, text: item.content, historical_message: true });
      if (turnId && lastAssistant.get(turnId) === index && !terminalTurns.has(turnId)) {
        events.push({
          type: EVENT.result, turn_id: turnId,
          outcome: item.partial ? 'failed' : 'completed',
        });
      }
    }
  }
  return events;
}

function presentationSource(records, truncated) {
  if (!truncated) return records;
  const boundary = records.findIndex((record) => record?.type === 'compaction_snapshot'
    && Array.isArray(record.payload?.records));
  if (boundary < 0) return records;
  const snapshot = records[boundary].payload;
  const seeded = snapshot.records.map((payload) => ({ type: payload.type, payload }));
  seeded.push({ type: 'compaction', payload: snapshot.fact });
  return [...seeded, ...records.slice(boundary + 1)];
}

function committedCandidateKeys(records) {
  return new Set(records.filter((record) => record?.type === 'message'
    && record.payload?.role === ROLE.assistant).map((record) => candidateKey(record.payload)));
}

function candidateKey(item) {
  return `${turnIdentity(item) ?? ''}\u0000${item?.stepId ?? ''}\u0000${item?.content ?? ''}`;
}

function appendMessageEvent(events, item) {
  validateTranscriptItem(item);
  if (item.role === ROLE.user) events.push({ type: EVENT.input, text: item.content });
  else if (item.role === ROLE.assistant) events.push({
    type: EVENT.delta, turn_id: turnIdentity(item), text: item.content, historical_message: true,
  });
}

function historicalToolEvent(item, requests) {
  const request = requests.get(item.requestId) ?? requests.get(item.providerCallId) ?? null;
  return {
    type: 'tool_status', turn_id: turnIdentity(item),
    tool_request_id: item.requestId ?? null, provider_call_id: item.providerCallId ?? null,
    tool: item.toolName ?? request?.toolName ?? 'unknown_tool', status: item.status,
    target: presentedToolTarget(item.toolName ?? request?.toolName, request?.args),
    elapsed_ms: item.elapsedMs ?? null, effect_certainty: item.effectCertainty ?? null,
    reason_code: item.reasonCode ?? null,
    observation_outcome: item.metadata?.observation_outcome ?? null,
    diagnostic_outcome: item.metadata?.diagnosticOutcome ?? null,
    diagnostic_visibility: item.metadata?.diagnosticVisibility ?? null,
  };
}

function compactionEvent(fact) {
  const projection = fact?.projection ?? {};
  return {
    type: 'context_compaction_status', status: 'completed', historical: true,
    before_estimated_tokens: byteTokenEstimate(projection.originalBytes),
    after_estimated_tokens: byteTokenEstimate(projection.projectedBytes),
    retained_records: fact?.retainedRecords?.length ?? 0,
    protected_turns: projection.protectedTurnCount ?? 0,
    payload_compacted_records: projection.payloadCompactedRecords ?? 0,
  };
}

function interruptedTurnEvent(item) {
  return {
    type: EVENT.result, turn_id: turnIdentity(item), outcome: 'failed', partial: true,
    failure: { code: item.reason ?? 'process_interrupted' },
  };
}

function byteTokenEstimate(bytes) {
  return Number.isFinite(bytes) ? Math.ceil(bytes / 3) : null;
}

function validateJournalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.type !== 'string' || !record.payload || typeof record.payload !== 'object') {
    throw new ContractError('transcript_record_invalid', 'saved journal contains an invalid record');
  }
}

function turnIdentity(item) {
  return item.turnId ?? item.turn_id ?? null;
}

function validateTranscriptItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string') {
    throw new ContractError('transcript_record_invalid', 'saved transcript contains an invalid record');
  }
}
