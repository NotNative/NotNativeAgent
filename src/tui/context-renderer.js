// SPDX-License-Identifier: Apache-2.0

const TRIGGERS = Object.freeze({
  tool_payload_budget: 'tool payload budget (early cleanup)',
  completed_turn_interval: 'conversation refresh under context pressure',
  provider_context_limit: 'provider rejected context size',
  stale_continuation_artifact: 'continuation integrity repair',
  context_preflight: 'context budget pressure',
});

export function contextCompactionText(record) {
  if (!record || typeof record !== 'object') return '  CONTEXT | compaction failed | unknown';
  const reason = TRIGGERS[record.trigger] ?? record.trigger ?? 'unknown';
  const basis = record.measurement_basis === 'complete_provider_input' ? 'estimated complete input' : 'estimated input';
  let summary;
  if (record.status === 'started') {
    summary = `  CONTEXT | compacting | reason: ${reason}\n  ${basis}: ${formatTokens(record.before_estimated_tokens)}${utilization(record.before_estimated_tokens, record.effective_input_tokens)} | reduction target <= ${formatTokens(record.target_tokens)}`;
  } else if (record.status === 'completed') {
    const saved = Number.isFinite(record.before_estimated_tokens) && Number.isFinite(record.after_estimated_tokens)
      ? ` | saved ${formatTokens(Math.max(0, record.before_estimated_tokens - record.after_estimated_tokens))}` : '';
    summary = `  CONTEXT | compacted | reason: ${reason}\n  ${basis}: ${formatTokens(record.before_estimated_tokens)} -> ${formatTokens(record.after_estimated_tokens)}${saved}${utilization(record.after_estimated_tokens, record.effective_input_tokens)}`;
    summary += `\n  Retained ${record.retained_records ?? 0} recent records | protected ${record.protected_turns ?? 0} recent turns | reduced ${record.payload_compacted_records ?? 0} payloads`;
  } else if (record.status === 'skipped') {
    summary = `  CONTEXT | compaction skipped | input preserved | ${record.reason_code ?? 'unknown'}`;
  } else return `  CONTEXT | compaction failed | ${record.reason_code ?? 'unknown'}`;
  return `${summary}${budgetText(record)}`;
}

function budgetText(record) {
  if (!Number.isFinite(record.context_window_tokens)) return '';
  const source = record.source ? ` | source: ${record.source}` : '';
  const ceiling = Number.isFinite(record.admissible_ceiling_tokens)
    ? `\n  Context pressure threshold: ${formatTokens(record.admissible_ceiling_tokens)} | limiting budget: ${record.binding_ceiling ?? 'unknown'}` : '';
  return `\n  Window: ${formatTokens(record.context_window_tokens)} | usable input: ${formatTokens(record.effective_input_tokens)} | output reserve: ${formatTokens(record.output_reserve_tokens)}${source}${ceiling}`;
}

function utilization(input, budget) {
  return Number.isFinite(input) && Number.isFinite(budget) && budget > 0
    ? ` (${(input / budget * 100).toFixed(1)}% of usable input)` : '';
}

function formatTokens(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value)).toLocaleString('en-US')} tokens` : 'unknown';
}
