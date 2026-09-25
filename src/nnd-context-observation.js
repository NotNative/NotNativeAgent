// SPDX-License-Identifier: Apache-2.0

/** Project numeric engine measurements only; context text never crosses the GUI boundary. */
export function nndContextObservation(record) {
  const used = record?.type === 'context_status' ? record.estimated_tokens
    : record?.type === 'context_usage' ? record.current_estimated_tokens : null;
  if (!Number.isSafeInteger(used) || used < 0) return null;
  const limit = record.limit_tokens;
  return {
    estimatedTokens: used,
    limitTokens: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    measurement: 'estimated',
    observedAt: Date.now(),
  };
}
