// SPDX-License-Identifier: Apache-2.0
export function restoreTranscript(projection, sessionId, transcript) {
  for (const event of transcriptEvents(transcript)) projection.apply(sessionId, event);
}

export function transcriptEvents(transcript) {
  const lastAssistant = new Map();
  const terminalTurns = new Set();
  transcript.forEach((item, index) => {
    if (item.type === 'message' && item.role === 'assistant' && item.turnId) lastAssistant.set(item.turnId, index);
    if (item.type === 'turn_outcome') terminalTurns.add(item.turn_id);
  });
  const events = [];
  for (const [index, item] of transcript.entries()) {
    if (item.type === 'turn_outcome') {
      events.push({ ...item, type: 'turn_result' });
      continue;
    }
    if (item.type !== 'message') continue;
    if (item.role === 'user') events.push({ type: 'user_input', text: item.content });
    else if (item.role === 'assistant') {
      events.push({ type: 'stream_delta', turn_id: item.turnId, text: item.content });
      if (item.turnId && lastAssistant.get(item.turnId) === index && !terminalTurns.has(item.turnId)) {
        events.push({ type: 'turn_result', turn_id: item.turnId, outcome: item.partial ? 'failed' : 'completed' });
      }
    }
  }
  return events;
}
