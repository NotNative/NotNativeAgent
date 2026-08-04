// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from './redaction.js';

const SECRET_KEY = /^(?:api[_-]?key|authorization|bearer|credential|credential_env|password|private[_-]?key|secret|access[_-]?token|refresh[_-]?token|token)$/iu;
const DEFAULTS = Object.freeze({ maxDepth: 16, maxNodes: 20_000, maxStringBytes: 65_536, maxArray: 1024, maxKeys: 1024 });

export function sanitizeTelemetry(value, options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const state = { nodes: 0, seen: new WeakSet() };
  return visit(value, 0, limits, state);
}

function visit(value, depth, limits, state) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) return marker('structure_limit', null);
  if (depth > limits.maxDepth) return marker('depth_limit', null);
  if (typeof value === 'string') return boundedText(value, limits.maxStringBytes);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean' || value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return String(value);
  if (state.seen.has(value)) return marker('circular_reference', null);
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, limits.maxArray).map((item) => visit(item, depth + 1, limits, state));
    if (value.length > limits.maxArray) result.push(marker('array_limit', { omitted: value.length - limits.maxArray }));
    return result;
  }
  const result = {};
  const entries = Object.entries(value);
  for (const [key, child] of entries.slice(0, limits.maxKeys)) {
    result[key] = SECRET_KEY.test(key) ? '[redacted]' : visit(child, depth + 1, limits, state);
  }
  if (entries.length > limits.maxKeys) result._nna_omitted_keys = entries.length - limits.maxKeys;
  return result;
}

function boundedText(value, maximum) {
  const redacted = redactText(value);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  if (bytes <= maximum) return redacted;
  const headBudget = Math.floor(maximum * 0.6);
  const tailBudget = maximum - headBudget;
  return marker('text_truncated', {
    bytes,
    sha256: createHash('sha256').update(redacted).digest('hex'),
    head: takeBytes(redacted, headBudget, false),
    tail: takeBytes(redacted, tailBudget, true),
  });
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
  return Object.freeze({
    id: row.id, timestamp: row.timestamp, event_name: row.event_name, status: row.status,
    duration_ms: row.duration_ms, sequence: row.sequence, source: row.source,
    runtime_id: row.runtime_id, session_id: row.session_id, conversation_id: row.conversation_id,
    turn_id: row.turn_id, step_id: row.step_id, attempt_id: row.attempt_id,
    agent_run_id: row.agent_run_id, parent_agent_run_id: row.parent_agent_run_id,
    provider_request_id: row.provider_request_id, tool_request_id: row.tool_request_id,
    hook_invocation_id: row.hook_invocation_id, span_id: row.span_id,
    parent_span_id: row.parent_span_id, outcome: row.outcome, reason_code: row.reason_code,
    effect_certainty: row.effect_certainty, payload_summary: summarizePayload(row.payload),
  });
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const result = {};
  for (const key of ['type', 'category', 'phase', 'code', 'reason_code', 'status', 'outcome', 'tool_name', 'model_name', 'route', 'retryable', 'bytes', 'count', 'source', 'button', 'target', 'characters', 'lines']) {
    const value = payload[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? Object.freeze(result) : null;
}
