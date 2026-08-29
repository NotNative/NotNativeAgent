// SPDX-License-Identifier: Apache-2.0

const TOOL_LIFECYCLE_STATUSES = new Set([
  'succeeded', 'failed', 'completed_nonzero', 'cancelled', 'timed_out',
  'invalid_request', 'denied', 'unknown_effect',
]);
const REVIEW_OUTCOMES = new Set([
  'approve', 'deny_with_guidance', 'hard_deny', 'escalate_to_operator',
]);

export function toolLifecycleStatus(value) {
  const explicit = value?.toolLifecycleStatus ?? value?.tool_lifecycle_status;
  if (TOOL_LIFECYCLE_STATUSES.has(explicit)) return explicit;
  const legacy = value?.status;
  if (REVIEW_OUTCOMES.has(legacy)) return 'denied';
  return TOOL_LIFECYCLE_STATUSES.has(legacy) ? legacy : null;
}

export function toolReviewOutcome(value) {
  const explicit = value?.reviewOutcome ?? value?.review_outcome;
  if (REVIEW_OUTCOMES.has(explicit)) return explicit;
  return REVIEW_OUTCOMES.has(value?.status) ? value.status : null;
}

export function durableToolResultState(value) {
  const toolLifecycleStatusValue = toolLifecycleStatus(value);
  const reviewOutcome = toolReviewOutcome(value);
  return Object.freeze({
    toolLifecycleStatus: toolLifecycleStatusValue,
    ...(reviewOutcome ? { reviewOutcome } : {}),
  });
}
