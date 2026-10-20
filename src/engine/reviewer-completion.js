// SPDX-License-Identifier: Apache-2.0

const CARRIED_OUTCOMES = new Set(['blocked', 'failed', 'incomplete', 'needs_input', 'cancelled', 'denied']);
// Why: these classifications can never be settled by a later operation. Carrying them
// forward would rearm the completion gate on every future turn, and durable turn_outcome
// records written before they were classified as final still exist in old journals.
const NON_CARRIABLE_STATES = new Set(['not_approved', 'review_pending']);
const MAX_CARRIED_REQUESTS = 64;

export function carriedReviewerRequestIds(transcriptOrTerminal) {
  const terminal = latestTerminal(transcriptOrTerminal);
  if (!terminal || !CARRIED_OUTCOMES.has(terminal.outcome)) return Object.freeze([]);
  const state = terminal.reviewer_completion;
  if (state?.schema !== 'nna.reviewer-completion.v1' || !Array.isArray(state.unresolved)) return Object.freeze([]);
  return Object.freeze(state.unresolved
    .filter((item) => !NON_CARRIABLE_STATES.has(item?.state))
    .slice(0, MAX_CARRIED_REQUESTS)
    .map((item) => item?.request_id).filter((value) => typeof value === 'string' && value.length > 0));
}

export function carriedReviewerTurnIds(transcriptOrTerminal) {
  const terminal = latestTerminal(transcriptOrTerminal);
  if (!terminal || !CARRIED_OUTCOMES.has(terminal.outcome)) return Object.freeze([]);
  const state = terminal.reviewer_completion;
  if (state?.schema !== 'nna.reviewer-completion.v1') return Object.freeze([]);
  const origins = Array.isArray(state.unresolved_turn_ids) ? state.unresolved_turn_ids
    : state.unresolved?.filter((item) => !NON_CARRIABLE_STATES.has(item?.state))
      .map((item) => item?.origin_turn_id) ?? [];
  return Object.freeze([...new Set(origins.filter((id) => typeof id === 'string' && id.length > 0))]
    .slice(0, MAX_CARRIED_REQUESTS));
}

export function carriedReviewerOverflow(transcriptOrTerminal) {
  const terminal = latestTerminal(transcriptOrTerminal);
  return Boolean(terminal && CARRIED_OUTCOMES.has(terminal.outcome)
    && (terminal.reviewer_completion?.unresolved_turn_ids_truncated
      || terminal.reviewer_completion?.carry_overflow
      || (terminal.reviewer_completion?.unresolved_truncated
        && !Array.isArray(terminal.reviewer_completion?.unresolved_turn_ids))));
}

function latestTerminal(value) {
  return Array.isArray(value) ? [...value].reverse().find((item) => item?.type === 'turn_outcome') : value;
}

export function initializeReviewerCarry(active, terminal) {
  active.carriedReviewerRequestIds = carriedReviewerRequestIds(terminal);
  active.carriedReviewerTurnIds = carriedReviewerTurnIds(terminal);
  active.carriedReviewerOverflow = carriedReviewerOverflow(terminal);
}

export function refreshReviewerCompletion(engine, active) {
  const state = engine.ledger.completionState({
    turnIds: [active.turnId], carriedTurnIds: active.carriedReviewerTurnIds,
    requestIds: active.carriedReviewerRequestIds,
  });
  const overflow = active.carriedReviewerOverflow || state.unresolved_turn_ids_truncated;
  active.reviewerCompletion = overflow ? Object.freeze({ ...state, carry_overflow: true,
    unresolved_count: Math.max(1, state.unresolved_count), unresolved_truncated: true }) : state;
  return active.reviewerCompletion;
}

export function reviewerCompletionHint(state) {
  if (state?.unresolved_count < 1) return null;
  const records = state.unresolved.map((item) => ({
    request_id: item.request_id, tool: item.tool, state: item.state,
    reason_code: item.reason_code, effect_certainty: item.effect_certainty,
  }));
  return `Unresolved reviewed tool outcomes remain:\n${JSON.stringify(records)}${state.carry_overflow ? '\nThe prior carry exceeded its bounded origin list; completion requires operator reconciliation of the reviewer ledger.' : ''}\nInspect each target before retrying an operation that may have applied. Retry only when its effect is safely repeatable or known not to have applied. If effects remain uncertain, use turn_finish with blocked, incomplete, failed, or needs_input. Do not report completion without settlement evidence.`;
}
