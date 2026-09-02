// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const RECORD = Object.freeze({ message: 'message', outcome: 'turn_outcome' });
const ROLE = Object.freeze({ assistant: 'assistant', user: 'user' });
const EVENT = Object.freeze({ input: 'user_input', delta: 'stream_delta', result: 'turn_result' });

export function restoreTranscript(projection, sessionId, transcript) {
  for (const event of transcriptEvents(transcript)) projection.apply(sessionId, event);
}

export function transcriptEvents(transcript) {
  if (!Array.isArray(transcript)) {
    throw new ContractError('transcript_invalid', 'saved transcript must be an array');
  }
  const lastAssistant = new Map();
  const terminalTurns = new Set();
  transcript.forEach((item, index) => {
    validateTranscriptItem(item);
    const turnId = turnIdentity(item);
    if (item.type === RECORD.message && item.role === ROLE.assistant && turnId) {
      lastAssistant.set(turnId, index);
    }
    if (item.type === RECORD.outcome && turnId) terminalTurns.add(turnId);
  });
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

function turnIdentity(item) {
  return item.turnId ?? item.turn_id ?? null;
}

function validateTranscriptItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string') {
    throw new ContractError('transcript_record_invalid', 'saved transcript contains an invalid record');
  }
}
