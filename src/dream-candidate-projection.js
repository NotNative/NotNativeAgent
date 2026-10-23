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
