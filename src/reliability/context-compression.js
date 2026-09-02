// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { estimateContextTokens } from './context-budget.js';
import { toolLifecycleStatus } from '../tools/tool-result-contract.js';

export const CONTEXT_COMPRESSION_POLICY_SCHEMA = 'nna.context-compression-policy.v1';
export const CONTEXT_COMPRESSION_MEASUREMENT_SCHEMA = 'nna.context-compression-measurement.v1';
export const COMPRESSION_CLASS = Object.freeze({
  lossless: 'lossless',
  recoverable: 'recoverable',
  semantic: 'semantic',
  protected: 'protected',
});

const ALLOWED_REDUCERS = Object.freeze({
  lossless: Object.freeze(['content_identity_dedup_v1', 'structure_preserving_whitespace_v1']),
  recoverable: Object.freeze(['content_identity_dedup_v1', 'ledger_backed_receipt_v1', 'bounded_head_tail_v1']),
  semantic: Object.freeze(['validated_continuation_v1']),
  protected: Object.freeze([]),
});

export function contextCompressionPolicy(record, options = {}) {
  const compressionClass = compressionClassFor(record, options);
  return Object.freeze({
    schema: CONTEXT_COMPRESSION_POLICY_SCHEMA,
    class: compressionClass,
    automatic: compressionClass !== COMPRESSION_CLASS.protected,
    requiresDurableSource: compressionClass === COMPRESSION_CLASS.recoverable
      || compressionClass === COMPRESSION_CLASS.semantic,
    allowedReducers: ALLOWED_REDUCERS[compressionClass],
    reason: compressionReason(record, options, compressionClass),
  });
}

export function measureContextCompression(before, after, options = {}) {
  const beforeBytes = serializedBytes(before);
  const afterBytes = serializedBytes(after);
  const counter = resolveTokenCounter(options);
  const beforeTokens = countTokens(counter, before);
  const afterTokens = countTokens(counter, after);
  const bytesSaved = Math.max(0, beforeBytes - afterBytes);
  const tokensSaved = Math.max(0, beforeTokens.value - afterTokens.value);
  const degraded = beforeTokens.degraded || afterTokens.degraded;
  const rediscovery = normalizeRediscovery(options.rediscovery);
  return Object.freeze({
    schema: CONTEXT_COMPRESSION_MEASUREMENT_SCHEMA,
    source_fingerprint: fingerprint(before),
    projection_fingerprint: fingerprint(after),
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    bytes_saved: bytesSaved,
    byte_reduction_ratio: reductionRatio(beforeBytes, afterBytes),
    before_tokens: beforeTokens.value,
    after_tokens: afterTokens.value,
    tokens_saved: tokensSaved,
    token_reduction_ratio: reductionRatio(beforeTokens.value, afterTokens.value),
    tokenizer: Object.freeze({
      identity: degraded ? 'conservative_utf8_v2' : counter.identity,
      requested_identity: counter.identity,
      exact: degraded ? false : counter.exact,
      degraded,
    }),
    reducers: Object.freeze(normalizeReducers(options.reducers)),
    rediscovery,
    net_tokens_saved: tokensSaved - rediscovery.estimated_tokens,
  });
}

export function compareCompressionOutcomes(baseline, compressed) {
  const dimensions = Object.freeze({
    status: normalized(baseline?.status) === normalized(compressed?.status),
    tool_decisions: fingerprint(baseline?.toolDecisions ?? []) === fingerprint(compressed?.toolDecisions ?? []),
    final_outcome: fingerprint(baseline?.finalOutcome ?? null) === fingerprint(compressed?.finalOutcome ?? null),
  });
  return Object.freeze({
    schema: 'nna.context-compression-equivalence.v1',
    equivalent: Object.values(dimensions).every(Boolean),
    dimensions,
    baseline_fingerprint: fingerprint(baseline ?? null),
    compressed_fingerprint: fingerprint(compressed ?? null),
  });
}

function compressionClassFor(record, options) {
  const kind = options.kind ?? record?.type ?? 'unknown';
  if (options.active === true || options.authority === true || kind === 'tool_schema') return COMPRESSION_CLASS.protected;
  if (kind === 'message' && ['user', 'system'].includes(record?.role)) return COMPRESSION_CLASS.protected;
  if (kind === 'context_checkpoint' || kind === 'compaction') return COMPRESSION_CLASS.protected;
  if (kind === 'tool_result') {
    return toolLifecycleStatus(record) === 'succeeded' && options.durableSource !== false
      ? COMPRESSION_CLASS.recoverable : COMPRESSION_CLASS.protected;
  }
  if (kind === 'tool_request') {
    return options.durableSource === false ? COMPRESSION_CLASS.protected : COMPRESSION_CLASS.recoverable;
  }
  if (kind === 'message' && record?.role === 'assistant') {
    return options.durableSource === false ? COMPRESSION_CLASS.protected : COMPRESSION_CLASS.semantic;
  }
  return COMPRESSION_CLASS.lossless;
}

function compressionReason(record, options, compressionClass) {
  if (options.active === true) return 'active_content';
  if (options.authority === true) return 'authenticated_authority';
  if ((options.kind ?? record?.type) === 'tool_schema') return 'tool_contract';
  if (record?.type === 'message' && record?.role === 'user') return 'authenticated_user_input';
  if (record?.type === 'message' && record?.role === 'system') return 'system_contract';
  if (options.durableSource === false && compressionClass !== COMPRESSION_CLASS.lossless) return 'durable_source_unavailable';
  if (record?.type === 'tool_result' && toolLifecycleStatus(record) !== 'succeeded') return 'unsettled_or_failed_result';
  return `${compressionClass}_content`;
}

function resolveTokenCounter(options) {
  const configured = options.tokenCounter;
  if (typeof configured === 'function') {
    return { count: configured, identity: safeIdentity(options.tokenizerIdentity), exact: options.tokenizerExact === true };
  }
  if (configured && typeof configured.count === 'function') {
    return {
      count: configured.count.bind(configured),
      identity: safeIdentity(configured.identity ?? options.tokenizerIdentity),
      exact: configured.exact === true,
    };
  }
  return { count: estimateContextTokens, identity: 'conservative_utf8_v2', exact: false };
}

function countTokens(counter, records) {
  try {
    const value = counter.count(records);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid token count');
    return { value, degraded: false };
  } catch {
    return { value: estimateContextTokens(records), degraded: counter.identity !== 'conservative_utf8_v2' };
  }
}

function normalizeReducers(reducers) {
  if (!Array.isArray(reducers)) return [];
  return reducers.slice(0, 32).map((item) => Object.freeze({
    name: boundedString(item?.name, 128) ?? 'unknown',
    class: Object.values(COMPRESSION_CLASS).includes(item?.class) ? item.class : COMPRESSION_CLASS.protected,
    records: nonNegativeInteger(item?.records),
    bytes_saved: nonNegativeInteger(item?.bytesSaved ?? item?.bytes_saved),
  }));
}

function normalizeRediscovery(value) {
  return Object.freeze({
    tool_calls: nonNegativeInteger(value?.toolCalls ?? value?.tool_calls),
    bytes: nonNegativeInteger(value?.bytes),
    estimated_tokens: nonNegativeInteger(value?.estimatedTokens ?? value?.estimated_tokens),
  });
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Buffer.byteLength(String(value ?? ''), 'utf8'); }
}

function fingerprint(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { serialized = String(value ?? ''); }
  return createHash('sha256').update(serialized ?? '[undefined]').digest('hex');
}

function reductionRatio(before, after) {
  return before > 0 ? Math.max(0, Math.min(1, (before - after) / before)) : 0;
}

function normalized(value) { return typeof value === 'string' ? value.trim().toLowerCase() : value ?? null; }
function safeIdentity(value) { return boundedString(value, 128) ?? 'custom_tokenizer'; }
function boundedString(value, length) { return typeof value === 'string' && value ? value.slice(0, length) : null; }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
