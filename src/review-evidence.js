// SPDX-License-Identifier: Apache-2.0
import { redactText } from './redaction.js';

const MAX_RECORDS = 8;
const MAX_ITEM_BYTES = 2_048;
const MAX_TOTAL_BYTES = 8_192;

export function recentReviewEvidence(transcript, currentRequestId) {
  const evidence = [];
  let remaining = MAX_TOTAL_BYTES;
  for (let index = transcript.length - 1; index >= 0 && evidence.length < MAX_RECORDS; index -= 1) {
    const item = evidenceItem(transcript[index], currentRequestId);
    if (!item) continue;
    const content = takeBytes(item.content, Math.min(MAX_ITEM_BYTES, remaining));
    if (content.length === 0) continue;
    evidence.unshift(Object.freeze({ ...item, content }));
    remaining -= Buffer.byteLength(content, 'utf8');
    if (remaining <= 0) break;
  }
  return Object.freeze(evidence);
}

function evidenceItem(record, currentRequestId) {
  if (!record || record.requestId === currentRequestId) return null;
  if (record.type === 'message' && record.role === 'assistant' && !record.partial) {
    return { type: 'assistant_message', trust: 'untrusted_model', content: redactText(record.content) };
  }
  if (record.type === 'tool_result') {
    return {
      type: 'tool_result', trust: 'untrusted_tool', tool: record.toolName,
      status: record.status, content: redactText(record.content),
    };
  }
  return null;
}

function takeBytes(value, maximum) {
  if (maximum <= 0) return '';
  const source = String(value);
  if (Buffer.byteLength(source, 'utf8') <= maximum) return source;
  let result = '';
  for (const character of source) {
    if (Buffer.byteLength(result + character, 'utf8') > maximum) break;
    result += character;
  }
  return result;
}
