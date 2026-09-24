// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from './redaction.js';

const MAX_ITEMS = 48;
const MAX_ITEM_BYTES = 4_096;
const MAX_TOTAL_BYTES = 24_576;
const TRUST_BY_ROLE = Object.freeze({
  user: 'authenticated_utterance', assistant: 'untrusted_model',
});

export const EMPTY_CONVERSATION_TEXT_LANE = Object.freeze({
  assembled_by: 'nna', source: 'session_transcript',
  item_count: 0, omitted_items: 0, content_bytes: 0,
  items: Object.freeze([]),
});

// Security: NNA owns every transcript write. A `user` record can originate only from
// authenticated ingress and an `assistant` record only from provider output, so role
// attribution is a mechanical fact, not a claim inside the text. The lane certifies
// utterance fidelity and order; it never grants authority. Authority stays in the
// authenticated intent records a decision must cite. Byte bounds omit older utterances
// and the omission count remains visible.
export function buildConversationTextLane(transcript) {
  const records = Array.isArray(transcript) ? transcript : [];
  const eligible = [];
  for (let index = 0; index < records.length; index += 1) {
    if (laneCandidate(records[index])) eligible.push(records[index]);
  }
  const selected = [];
  let remaining = MAX_TOTAL_BYTES;
  for (let index = eligible.length - 1; index >= 0 && selected.length < MAX_ITEMS && remaining > 0; index -= 1) {
    const record = eligible[index];
    const content = takeBytes(redactText(record.content), MAX_ITEM_BYTES);
    if (!content) continue;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > remaining) break;
    remaining -= bytes;
    selected.unshift({
      index: 0, role: record.role, turn_id: boundedIdentity(record.turnId),
      trust: TRUST_BY_ROLE[record.role], content,
      content_sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  selected.forEach((item, position) => { item.index = position; });
  const contentBytes = MAX_TOTAL_BYTES - remaining;
  return Object.freeze({
    assembled_by: 'nna', source: 'session_transcript',
    item_count: selected.length, omitted_items: eligible.length - selected.length,
    content_bytes: contentBytes,
    items: Object.freeze(selected),
  });
}

function laneCandidate(record) {
  return record?.type === 'message' && record.partial !== true
    && Object.hasOwn(TRUST_BY_ROLE, record.role)
    && typeof record.content === 'string' && record.content.length > 0;
}

function boundedIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function takeBytes(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || limit <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  return Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '');
}
