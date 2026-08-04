// SPDX-License-Identifier: Apache-2.0

export function contextCompactionText(record) {
  if (record.status === 'started') {
    return `  CONTEXT | compacting | ${formatTokens(record.before_estimated_tokens)} -> target ${formatTokens(record.target_tokens)}`;
  }
  if (record.status === 'completed') {
    return `* Context compacted | ${formatTokens(record.before_estimated_tokens)} -> ${formatTokens(record.after_estimated_tokens)} | retained ${record.retained_records ?? 0} recent records`;
  }
  return `! Context compaction failed | ${record.reason_code ?? 'unknown'}`;
}

function formatTokens(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value)).toLocaleString('en-US')} tokens` : 'unknown';
}
