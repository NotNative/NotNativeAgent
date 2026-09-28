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

/** Only this bounded numeric shape may be restored into a session projection. */
export function validNndContextObservation(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 4
    && Number.isSafeInteger(value.estimatedTokens) && value.estimatedTokens >= 0
    && (value.limitTokens === null || Number.isSafeInteger(value.limitTokens) && value.limitTokens > 0)
    && value.measurement === 'estimated'
    && Number.isSafeInteger(value.observedAt) && value.observedAt > 0;
}
