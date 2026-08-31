// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_UNRECOGNIZED_DELTA_FIELDS = 16;
const RECOGNIZED_DELTA_FIELDS = new Set(['role', 'reasoning', 'reasoning_content', 'content', 'tool_calls']);

export function createProviderEventShape() {
  return {
    transport_activity_events: 0, transport_bytes: 0,
    text_events: 0, text_bytes: 0,
    reasoning_events: 0, reasoning_bytes: 0,
    tool_fragment_events: 0, tool_fragment_count: 0,
    usage_events: 0, metadata_events: 0, terminal_events: 0,
    unrecognized_delta_events: 0, unrecognized_delta_fields: new Set(),
  };
}

export function observeProviderEventShape(shape, item) {
  if (item.type === 'transport_activity') {
    shape.transport_activity_events += 1; shape.transport_bytes += item.bytes;
  } else if (item.type === 'text') {
    shape.text_events += 1; shape.text_bytes += Buffer.byteLength(item.text, 'utf8');
  } else if (item.type === 'reasoning') {
    shape.reasoning_events += 1; shape.reasoning_bytes += Buffer.byteLength(item.text, 'utf8');
  } else if (item.type === 'tool_fragment') {
    shape.tool_fragment_events += 1; shape.tool_fragment_count += item.fragments.length;
  } else if (item.type === 'usage') shape.usage_events += 1;
  else if (item.type === 'metadata') shape.metadata_events += 1;
  else if (item.type === 'terminal') shape.terminal_events += 1;
  else if (item.type === 'unrecognized_delta') {
    shape.unrecognized_delta_events += 1;
    for (const field of item.fields) {
      if (shape.unrecognized_delta_fields.size >= MAX_UNRECOGNIZED_DELTA_FIELDS) break;
      shape.unrecognized_delta_fields.add(field);
    }
  }
}

export function unrecognizedDeltaEvent(delta) {
  const fields = Object.keys(delta)
    .filter((field) => !RECOGNIZED_DELTA_FIELDS.has(field))
    .slice(0, MAX_UNRECOGNIZED_DELTA_FIELDS)
    .map(boundedProviderFieldName);
  return fields.length > 0 ? { type: 'unrecognized_delta', fields } : null;
}

export function isValidUnrecognizedDeltaEvent(item) {
  return item.type === 'unrecognized_delta' && Array.isArray(item.fields)
    && item.fields.length > 0 && item.fields.length <= MAX_UNRECOGNIZED_DELTA_FIELDS
    && item.fields.every((field) => typeof field === 'string' && field.length > 0 && field.length <= 64);
}

export function sanitizeProviderUsage(usage) {
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (usage[key] === undefined) continue;
    if (!Number.isInteger(usage[key]) || usage[key] < 0) {
      throw new ContractError('provider_usage_invalid', 'provider emitted invalid usage metadata');
    }
    result[key] = usage[key];
  }
  return result;
}

function boundedProviderFieldName(value) {
  const result = String(value).replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64);
  return result || 'unnamed';
}
