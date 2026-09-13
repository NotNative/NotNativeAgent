// SPDX-License-Identifier: Apache-2.0

const CARRIED_OUTCOMES = new Set(['blocked', 'failed', 'incomplete', 'needs_input']);
// Why: these classifications can never be settled by a later operation. Carrying them
// forward would rearm the completion gate on every future turn, and durable turn_outcome
// records written before they were classified as final still exist in old journals.
const NON_CARRIABLE_STATES = new Set(['not_approved', 'review_pending']);
const MAX_CARRIED_REQUESTS = 64;

export function carriedReviewerRequestIds(transcript) {
  if (!Array.isArray(transcript)) return Object.freeze([]);
  const terminal = [...transcript].reverse().find((item) => item?.type === 'turn_outcome');
  if (!terminal || !CARRIED_OUTCOMES.has(terminal.outcome)) return Object.freeze([]);
  const state = terminal.reviewer_completion;
  if (state?.schema !== 'nna.reviewer-completion.v1' || !Array.isArray(state.unresolved)) return Object.freeze([]);
  return Object.freeze(state.unresolved
    .filter((item) => !NON_CARRIABLE_STATES.has(item?.state))
    .slice(0, MAX_CARRIED_REQUESTS)
    .map((item) => item?.request_id).filter((value) => typeof value === 'string' && value.length > 0));
}

export function refreshReviewerCompletion(engine, active) {
  const state = engine.ledger.completionState({
    turnIds: [active.turnId], requestIds: active.carriedReviewerRequestIds,
  });
  active.reviewerCompletion = state;
  return state;
}

export function reviewerCompletionHint(state) {
  if (state?.unresolved_count < 1) return null;
  const records = state.unresolved.map((item) => ({
    request_id: item.request_id, tool: item.tool, state: item.state,
    reason_code: item.reason_code, effect_certainty: item.effect_certainty,
  }));
  return `Unresolved reviewed tool outcomes remain:\n${JSON.stringify(records)}\nRetry or verify each operation. Otherwise, use turn_finish with blocked, incomplete, failed, or needs_input. Do not report completion without settlement evidence.`;
}
