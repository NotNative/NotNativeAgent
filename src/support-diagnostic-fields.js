// SPDX-License-Identifier: Apache-2.0

const FIELDS = new Set([
  'type', 'category', 'phase', 'code', 'reason_code', 'status', 'outcome', 'tool_name',
  'model_name', 'model', 'route', 'retryable', 'bytes', 'count', 'source', 'button', 'target', 'characters', 'lines',
  'trigger', 'measurement', 'measurement_basis', 'binding_ceiling', 'policy', 'record_type',
  'agent_id', 'child_session_id', 'parent_session_id', 'parent_turn_id', 'parent_step_id',
  'launching_tool_request_id', 'agent_run_id', 'parent_agent_run_id', 'agent_type', 'state',
  'provider_profile', 'authoritative', 'context_window_tokens', 'effective_input_tokens',
  'compression_threshold_tokens', 'compaction_threshold_tokens', 'output_reserve_tokens',
  'context_estimate_scale', 'parallel_capacity', 'hard_limit_bytes', 'threshold_bytes', 'scaled_tokens', 'retry_scale',
  'before_estimated_tokens', 'after_estimated_tokens', 'candidate_estimated_tokens', 'journal_estimated_tokens', 'target_tokens', 'admissible_ceiling_tokens',
  'before_bytes', 'after_bytes', 'bytes_saved', 'byte_reduction_ratio', 'before_tokens', 'after_tokens',
  'tokens_saved', 'token_reduction_ratio', 'net_tokens_saved', 'tokenizer_identity', 'tokenizer_exact', 'tokenizer_degraded',
  'raw_estimated_tokens', 'ratio', 'tier', 'cold_records', 'retained_active_steps', 'payloadBytes', 'inputBytes', 'completedTurns',
  'retained_records', 'omitted_records', 'protected_turns', 'payload_compacted_records', 'bounded_receipt_records',
  'source_tool_result_bytes', 'projected_tool_result_bytes', 'checkpoint_bytes', 'repeated_read_requests',
  'estimated_input_tokens', 'estimated_output_tokens', 'reserved_output_tokens', 'estimated_total_tokens',
  'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_tokens',
  'accounted_input_tokens', 'accounted_output_tokens', 'accounted_total_tokens', 'measured_total_tokens',
  'estimated_unreported_tokens', 'measurement_source', 'component_measurement', 'attempts', 'schema',
  'id', 'name', 'class', 'records', 'estimated_tokens', 'exact', 'degraded', 'identity',
  'requestId', 'toolName', 'turnId', 'operatorRequestId', 'signature', 'targetFingerprint', 'operationFingerprint',
  'repetition', 'decisionId', 'requestDigest', 'policyVersion', 'authorityId', 'authorityVersion',
  'authorityRestrictionVersion', 'committedAt', 'expiresAt', 'elapsedMs', 'risk', 'scope', 'effect', 'complexity',
  'provenance', 'reasonCode', 'freshness', 'conflict', 'sourceRef', 'sourceFingerprint', 'contentFingerprint',
  'kind', 'origin', 'trust', 'observedAt', 'domain', 'subjectRef', 'subjectFingerprint', 'decidedAt', 'at', 'from', 'to',
  'effectCertainty', 'authority_version', 'restriction_version', 'complete', 'timeout_ms',
  'attempted_calls', 'admitted_calls', 'invalid_calls', 'reused_calls', 'reserved_tool_calls',
  'transitionCount', 'transitionFingerprint', 'retained_evidence', 'retained_decisions', 'transition_history',
]);
const CONTAINERS = new Set(['accounting', 'envelope', 'sections', 'tokenizer', 'reducers', 'usage', 'by_role',
  'primary', 'reviewer', 'subagent', 'semantic_compaction', 'record', 'decision', 'execution', 'terminal',
  'classification', 'evidence', 'transition', 'lifecycle', 'attributes']);
const REFERENCES = new Set(['evidenceRefs', 'authorityRefs']);

export function supportDiagnosticSummary(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  if (Array.isArray(payload)) return payload.slice(0, 64).map((value) => supportDiagnosticSummary(value, depth + 1)).filter(Boolean);
  const result = {};
  for (const [key, value] of Object.entries(payload).slice(0, 256)) {
    if (FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    else if (REFERENCES.has(key) && Array.isArray(value)) result[key] = value.slice(0, 64).filter((item) => typeof item === 'string');
    else if (CONTAINERS.has(key)) {
      const child = supportDiagnosticSummary(value, depth + 1);
      if (child) result[key] = child;
    }
  }
  return Object.keys(result).length ? Object.freeze(result) : null;
}
