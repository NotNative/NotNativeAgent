// SPDX-License-Identifier: Apache-2.0

const MAX_INTENT_ITEMS = 8;
const MAX_ITEM_BYTES = 8_192;
const MAX_TOTAL_BYTES = 32_768;

export function projectConversationIntent(authority, options = {}) {
  const records = Array.isArray(authority?.intent) ? authority.intent : [];
  const selected = [];
  let remaining = MAX_TOTAL_BYTES;
  for (let index = records.length - 1; index >= 0 && selected.length < MAX_INTENT_ITEMS; index -= 1) {
    const content = takeBytes(records[index]?.content, Math.min(MAX_ITEM_BYTES, remaining));
    if (!content) continue;
    selected.unshift(content);
    remaining -= Buffer.byteLength(content, 'utf8');
    if (remaining <= 0) break;
  }
  retainTurnAnchor(selected, options.anchor);
  return Object.freeze(selected);
}

function retainTurnAnchor(selected, value) {
  const anchor = takeBytes(value, MAX_ITEM_BYTES);
  if (!anchor || selected.includes(anchor)) return;
  if (selected.length >= MAX_INTENT_ITEMS) selected.shift();
  selected.unshift(anchor);
  while (projectionBytes(selected) > MAX_TOTAL_BYTES && selected.length > 1) selected.splice(1, 1);
}

function projectionBytes(values) {
  return values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

function takeBytes(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || limit <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  return Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '');
}
