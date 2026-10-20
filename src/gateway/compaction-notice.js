// SPDX-License-Identifier: Apache-2.0
export function gatewayCompactionMessage(record) {
  if (record?.type !== 'context_compaction_status') return null;
  if (record.status === 'completed') {
    const before = record.before_estimated_tokens;
    const after = record.after_estimated_tokens;
    return Number.isSafeInteger(before) && Number.isSafeInteger(after)
      ? `NNA compacted context: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} estimated input tokens.`
      : 'NNA compacted context.';
  }
  if (record.status === 'skipped') return 'NNA skipped context compaction because input would not shrink.';
  if (record.status === 'failed') return 'NNA could not compact context; the turn may need a smaller request.';
  return null;
}
