// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './governance/contracts.js';

export function reliabilityCandidate(issue, evidenceId) {
  const reason = issue.reason;
  return {
    id: `candidate-recovery-${governanceFingerprint(reason).slice(0, 24)}`,
    kind: 'recovery.failure_pattern', confidence: Math.min(0.95, 0.5 + issue.count * 0.05),
    recurrenceCount: issue.count, evidenceRefs: [evidenceId],
    expectedBenefit: `Reduce repeated ${reason} failures without weakening safety policy.`,
    successCriteria: [
      `A bounded replay of ${reason} completes without the repeated failure.`,
      'Existing safety and regression checks continue to pass.',
    ],
    riskClass: 'diagnostic', payload: { failure_code: reason, proposed_action: 'investigate' },
  };
}

/** A per-route operating point learned from the scheduler's own evidence.
 *
 *  Why a candidate and not a direct limit: learned capacity bounds scheduling
 *  and never permission, so it enters through the same governed lifecycle as
 *  every other learned fact — observed, validated, proposed, operator-approved
 *  before anything constrains admission. The payload cites the route, the
 *  concurrency it was measured at, and the queue-wait evidence behind it. */
export function capacityCandidate({ route, concurrency, samples, medianQueueWaitMs, p95QueueWaitMs, evidenceId }) {
  const condition = governanceFingerprint({ route, concurrency });
  return {
    id: `candidate-capacity-${condition.slice(0, 24)}`,
    kind: 'capacity.route_operating_point', confidence: Math.min(0.9, 0.4 + samples * 0.02),
    recurrenceCount: samples, evidenceRefs: [evidenceId],
    expectedBenefit: `Bound admission on ${route} at concurrency ${concurrency} before queue waits grow, so held turns surface honestly instead of overflowing the provider.`,
    successCriteria: [
      `At concurrency ${concurrency + 1} the route's p95 queue wait exceeds the measured median at ${concurrency}.`,
      'A declared ceiling still caps the learned value; the operator bound is never widened.',
    ],
    riskClass: 'diagnostic',
    payload: {
      route, measured_concurrency: concurrency, samples,
      median_queue_wait_ms: medianQueueWaitMs, p95_queue_wait_ms: p95QueueWaitMs,
      proposed_action: 'propose_declared_ceiling',
    },
  };
}

export function candidateSummary(candidate, detail = false) {
  const summary = {
    id: candidate.id, kind: candidate.kind, state: candidate.state,
    confidence: Number(candidate.confidence), recurrence_count: Number(candidate.recurrence_count),
    risk_class: candidate.risk_class, expected_benefit: candidate.expected_benefit,
    updated_at: candidate.updated_at,
  };
  if (detail) Object.assign(summary, {
    evidence_refs: candidate.evidence_refs, success_criteria: candidate.success_criteria,
    rejection_reason: candidate.rejection_reason, expires_at: candidate.expires_at,
    payload_fingerprint: candidate.payload_fingerprint, payload: candidate.payload,
  });
  return Object.freeze(summary);
}
