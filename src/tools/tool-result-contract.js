// SPDX-License-Identifier: Apache-2.0

const TOOL_LIFECYCLE_STATUSES = new Set([
  'succeeded', 'failed', 'completed_nonzero', 'cancelled', 'timed_out',
  'invalid_request', 'denied', 'unknown_effect',
]);
const REVIEW_OUTCOMES = new Set([
  'approve', 'deny_with_guidance', 'hard_deny', 'escalate_to_operator',
]);
const TOOL_RESULT_PROJECTIONS = Object.freeze({
  succeeded: Object.freeze({ child: 'succeeded', telemetry: 'succeeded' }),
  failed: Object.freeze({ child: 'failed', telemetry: 'failed' }),
  completed_nonzero: Object.freeze({ child: 'failed', telemetry: 'failed' }),
  cancelled: Object.freeze({ child: 'cancelled', telemetry: 'cancelled' }),
  timed_out: Object.freeze({ child: 'timed_out', telemetry: 'timed_out' }),
  invalid_request: Object.freeze({ child: 'failed', telemetry: 'failed' }),
  denied: Object.freeze({ child: 'failed', telemetry: 'denied' }),
  unknown_effect: Object.freeze({ child: 'unknown_effect', telemetry: 'unknown_effect' }),
});

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

export function toolChildState(value) {
  return projectionFor(value).child;
}

export function toolTelemetryOutcome(value) {
  return projectionFor(value).telemetry;
}

function projectionFor(value) {
  const result = typeof value === 'string' ? { status: value } : value;
  const lifecycle = result?.effect_certainty === 'unknown'
    ? 'unknown_effect' : toolLifecycleStatus(result);
  return TOOL_RESULT_PROJECTIONS[lifecycle] ?? TOOL_RESULT_PROJECTIONS.failed;
}
