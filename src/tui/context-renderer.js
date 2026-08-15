// SPDX-License-Identifier: Apache-2.0

export function contextCompactionText(record) {
  if (!record || typeof record !== 'object') return '! Context compaction failed | unknown';
  if (record.status === 'started') {
    return `  CONTEXT | compacting | current ${formatTokens(record.before_estimated_tokens)} -> target <= ${formatTokens(record.target_tokens)}`;
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
