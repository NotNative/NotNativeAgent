// SPDX-License-Identifier: Apache-2.0

export function contextCompactionText(record) {
  if (!record || typeof record !== 'object') return '! Context compaction failed | unknown';
  if (record.status === 'started') {
    const trigger = record.trigger ? ` | trigger ${record.trigger}` : '';
    const window = record.context_window_tokens ? ` | window ${formatTokens(record.context_window_tokens)}` : '';
    const basis = record.measurement_basis === 'complete_provider_input' ? 'estimated input' : 'current';
    return `  CONTEXT | compacting | ${basis} ${formatTokens(record.before_estimated_tokens)} -> target <= ${formatTokens(record.target_tokens)}${trigger}${window}`;
  }
  if (record.status === 'completed') {
    const protectedText = record.protected_turns > 0 ? ` | protected ${record.protected_turns} recent turns` : '';
    const payloadText = record.payload_compacted_records > 0 ? ` | reduced ${record.payload_compacted_records} payloads` : '';
    return `* Context compacted | ${formatTokens(record.before_estimated_tokens)} -> ${formatTokens(record.after_estimated_tokens)} | retained ${record.retained_records ?? 0} recent records${protectedText}${payloadText}`;
  }
  return `! Context compaction failed | ${record.reason_code ?? 'unknown'}`;
}

function formatTokens(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value)).toLocaleString('en-US')} tokens` : 'unknown';
}
