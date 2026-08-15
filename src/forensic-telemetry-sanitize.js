// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from './redaction.js';
import { ContractError } from './ids.js';

const SECRET_KEY = /^(?:api[_-]?key|authorization|auth[_-]?token|bearer|credential(?:_env)?|password|private[_-]?key|secret|access[_-]?token|refresh[_-]?token|token)(?:[_-](?:bearer|hash|reset|value))?$/iu;
const DEFAULTS = Object.freeze({ maxDepth: 16, maxNodes: 20_000, maxStringBytes: 65_536, maxArray: 1024, maxKeys: 1024 });
const PAYLOAD_SUMMARY_FIELDS = Object.freeze([
  'type', 'category', 'phase', 'code', 'reason_code', 'status', 'outcome', 'tool_name',
  'model_name', 'route', 'retryable', 'bytes', 'count', 'source', 'button', 'target',
  'characters', 'lines',
]);

export function sanitizeTelemetry(value, options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const state = { nodes: 0, active: new WeakSet() };
  return visit(value, 0, limits, state);
}

function visit(value, depth, limits, state) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) return marker('structure_limit', null);
  if (depth > limits.maxDepth) return marker('depth_limit', null);
  if (typeof value === 'string') return boundedText(value, limits.maxStringBytes);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  // Normalize undefined to null so every retained property is JSON-compatible.
  if (typeof value === 'boolean' || value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return String(value);
  if (state.active.has(value)) return marker('circular_reference', null);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const result = value.slice(0, limits.maxArray).map((item) => visit(item, depth + 1, limits, state));
      if (value.length > limits.maxArray) result.push(marker('array_limit', { omitted: value.length - limits.maxArray }));
      return result;
    }
    if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.toISOString() : marker('invalid_date', null);
    if (value instanceof RegExp || value instanceof URL) return boundedText(String(value), limits.maxStringBytes);
    if (value instanceof Set) return visit([...value].slice(0, limits.maxArray), depth + 1, limits, state);
    if (value instanceof Map) return visitMap(value, depth, limits, state);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return marker('unsupported_object', { type: boundedText(value.constructor?.name ?? 'unknown', 128) });
    }
    const result = {};
    const entries = Object.entries(value);
    for (const [key, child] of entries.slice(0, limits.maxKeys)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : visit(child, depth + 1, limits, state);
    }
    if (entries.length > limits.maxKeys) result._nna_omitted_keys = entries.length - limits.maxKeys;
    return result;
  } finally { state.active.delete(value); }
}

function boundedText(value, maximum) {
  const redacted = redactText(value);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  if (bytes <= maximum) return redacted;
  const headBudget = Math.floor(maximum * 0.6);
  const tailBudget = maximum - headBudget;
  return marker('text_truncated', {
    bytes,
    hash_scope: 'redacted_full_text',
    sha256: createHash('sha256').update(redacted).digest('hex'),
    head: takeBytes(redacted, headBudget, false),
    tail: takeBytes(redacted, tailBudget, true),
  });
}

function visitMap(value, depth, limits, state) {
  const entries = [];
  let index = 0;
  for (const [key, child] of value) {
    if (index >= limits.maxArray) break;
    entries.push([
      visit(key, depth + 1, limits, state),
      typeof key === 'string' && SECRET_KEY.test(key) ? '[redacted]' : visit(child, depth + 1, limits, state),
    ]);
    index += 1;
  }
  if (value.size > limits.maxArray) entries.push(marker('array_limit', { omitted: value.size - limits.maxArray }));
  return entries;
}

function takeBytes(value, maximum, fromEnd) {
  const encoded = Buffer.from(value, 'utf8');
  const slice = fromEnd ? encoded.subarray(Math.max(0, encoded.length - maximum)) : encoded.subarray(0, maximum);
  return slice.toString('utf8').replace(/^\uFFFD|\uFFFD$/gu, '');
}

function marker(reason, details) {
  return Object.freeze({ _nna_telemetry: reason, ...(details ?? {}) });
}

export function supportTelemetryProjection(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new ContractError('telemetry_row_invalid', 'support telemetry projection requires a record');
  }
  return Object.freeze({
    id: row.id ?? null, timestamp: row.timestamp ?? null, event_name: row.event_name ?? null, status: row.status ?? null,
    duration_ms: row.duration_ms ?? null, sequence: row.sequence ?? null, source: row.source ?? null,
    runtime_id: row.runtime_id ?? null, session_id: row.session_id ?? null, conversation_id: row.conversation_id ?? null,
    turn_id: row.turn_id ?? null, step_id: row.step_id ?? null, attempt_id: row.attempt_id ?? null,
    agent_run_id: row.agent_run_id ?? null, parent_agent_run_id: row.parent_agent_run_id ?? null,
    provider_request_id: row.provider_request_id ?? null, tool_request_id: row.tool_request_id ?? null,
    hook_invocation_id: row.hook_invocation_id ?? null, span_id: row.span_id ?? null,
    parent_span_id: row.parent_span_id ?? null, outcome: row.outcome ?? null, reason_code: row.reason_code ?? null,
    effect_certainty: row.effect_certainty ?? null, payload_summary: summarizePayload(row.payload),
  });
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const result = {};
  for (const key of PAYLOAD_SUMMARY_FIELDS) {
    const value = payload[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? Object.freeze(result) : null;
}
