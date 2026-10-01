// SPDX-License-Identifier: Apache-2.0

const MAX_TURNS = 200;
const PROVIDER_PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
// Match requireExternalId: a valid submitted prompt must never disappear from
// accounting merely because it contains a dot or colon.
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function nndGoalContextEvidence(context) {
  return nndGoalEvidence(context.sessionId, context.engine.transcript, context.goalTurnReceipts,
    context.goalTurnReceiptsTruncated || context.engine.resumeBoundary?.hasMore === true);
}

/** Safe, bounded NNA turn receipt; no provider response or failure detail crosses this seam. */
export function nndGoalTurnReceipt(record) {
  if (!record || !['turn_result', 'turn_outcome'].includes(record.type)
    || typeof record.request_id !== 'string' || !REQUEST_ID.test(record.request_id)) return null;
  const accounted = record.token_accounting?.accounted_total_tokens;
  const measured = record.usage?.total_tokens ?? record.usage?.totalTokens;
  const accountingMeasurement = record.token_accounting?.measurement;
  const hasAccounted = count(accounted) !== null
    && ['provider', 'estimated', 'mixed'].includes(accountingMeasurement);
  const tokens = hasAccounted ? accounted : count(measured);
  const measurement = hasAccounted ? accountingMeasurement : count(measured) !== null ? 'provider' : 'unavailable';
  return Object.freeze({ request_id: record.request_id,
    outcome: typeof record.outcome === 'string' ? record.outcome.slice(0, 40) : 'unknown',
    tokens, measurement,
    ...(typeof record.provider_profile === 'string' && PROVIDER_PROFILE_ID.test(record.provider_profile)
      && typeof record.model === 'string' && record.model.length > 0 && record.model.length <= 256
      && record.model.trim() && !CONTROL_CHARACTER.test(record.model)
      ? { provider_profile: record.provider_profile, model: record.model } : {}) });
}

/** Live receipts are observational; the journal remains the restart authority. */
export function recordNndGoalTurn(context, record) {
  const receipt = nndGoalTurnReceipt(record);
  if (!receipt) return;
  context.goalTurnReceipts.push(receipt);
  if (context.goalTurnReceipts.length > MAX_TURNS) {
    context.goalTurnReceipts.shift();
    context.goalTurnReceiptsTruncated = true;
  }
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Journal-backed restored receipts plus live completions, de-duplicated by request id. */
export function nndGoalEvidence(sessionId, transcript, liveReceipts = [], liveTruncated = false) {
  const byId = new Map();
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    const receipt = nndGoalTurnReceipt(entry);
    if (receipt) byId.set(receipt.request_id, receipt);
  }
  for (const receipt of liveReceipts) {
    if (receipt && REQUEST_ID.test(receipt.request_id)) byId.set(receipt.request_id, receipt);
  }
  const all = [...byId.values()];
  const turns = all.slice(-MAX_TURNS);
  return Object.freeze({ session_id: sessionId, turns,
    latest_request_id: turns.at(-1)?.request_id ?? null,
    window_truncated: liveTruncated || all.length > MAX_TURNS
      || (Array.isArray(transcript) && transcript.some((entry) => entry?.type === 'compaction')) });
}
