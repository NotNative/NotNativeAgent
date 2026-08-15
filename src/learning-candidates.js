// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { governanceFingerprint } from './governance/contracts.js';

export const LEARNING_POLICY_VERSION = 'learning-promotion/1';

export class LearningCandidateRegistry {
  constructor(options) {
    assertDependencies(options);
    this.store = options.store;
    this.governance = options.governance;
    this.runtimeKey = options.runtimeKey;
    this.scope = Object.freeze({ ...options.scope });
    this.telemetry = options.telemetry ?? null;
  }

  async observe(input) {
    const sources = this.#usableEvidence(input.evidenceRefs);
    const candidate = this.store.observeCandidate({
      ...input, runtimeKey: this.runtimeKey, scope: input.scope ?? this.scope,
    });
    const evidence = await this.governance.registerEvidence({
      id: candidateEvidenceId(candidate.id), kind: 'improvement_candidate',
      origin: 'runtime', trust: 'observed', state: 'quarantined', freshness: 'current',
      conflict: 'none', sourceRef: candidate.id,
      sourceFingerprint: candidate.payload_fingerprint,
      contentFingerprint: candidate.payload_fingerprint,
      scope: input.scope ?? this.scope, observedAt: requiredTimestamp(candidate.created_at, 'candidate creation'),
      attributes: { candidate_kind: candidate.kind, risk_class: candidate.risk_class },
    });
    const observationKey = governanceFingerprint(sources.map((item) => item.id).sort().join(':')).slice(0, 24);
    const decision = await this.governance.decide({
      id: `governance:observe:${candidate.id}:${observationKey}`,
      domain: domainFor(candidate.kind), subjectRef: candidate.id,
      subjectFingerprint: candidate.payload_fingerprint, outcome: 'defer',
      reasonCode: 'candidate_requires_validation', policyVersion: LEARNING_POLICY_VERSION,
      evidenceRefs: [...sources.map((item) => item.id), evidence.id], authorityRefs: [],
      decidedAt: Math.max(...sources.map((item) => item.observedAt)),
      expiresAt: optionalTimestamp(candidate.expires_at, 'candidate expiration'),
      attributes: { candidate_state: candidate.state, candidate_kind: candidate.kind },
    });
    await this.governance.settleDecision(decision.id, {
      status: 'applied', effectCertainty: 'completed',
      resultFingerprint: candidate.payload_fingerprint,
      reasonCode: 'candidate_observation_recorded',
    });
    this.#telemetry('learning.candidate', 'succeeded', candidate, 'candidate_observed');
    return candidate;
  }

  async advance(id, state, detail = {}) {
    const current = this.#requireCandidate(id);
    if (state === 'active') throw new ContractError('learning_promotion_required', 'active candidates require governed promotion');
    if (state === 'rejected') return this.reject(id, detail.reason);
    const candidate = this.store.transitionCandidate(id, state, detail);
    this.#telemetry('learning.candidate', 'succeeded', candidate, `candidate_${state}`);
    return candidate;
  }

  async promote(id, input) {
    const candidate = this.#requireCandidate(id);
    if (candidate.state !== 'proposed') throw new ContractError('learning_candidate_not_proposed', 'only proposed candidates can be promoted');
    const sources = this.#usableEvidence(candidate.evidence_refs);
    const authorities = this.#authorities(input.authorityRefs);
    const decision = await this.governance.decide({
      id: input.decisionId ?? newId('learning_promotion'),
      domain: domainFor(candidate.kind), subjectRef: candidate.id,
      subjectFingerprint: candidate.payload_fingerprint, outcome: 'promote',
      reasonCode: input.reasonCode ?? 'evidence_and_authority_satisfied',
      policyVersion: LEARNING_POLICY_VERSION,
      evidenceRefs: [...sources.map((item) => item.id), candidateEvidenceId(candidate.id)],
      authorityRefs: authorities.map((item) => item.id), decidedAt: Date.now(),
      expiresAt: optionalTimestamp(candidate.expires_at, 'candidate expiration'),
      attributes: { candidate_kind: candidate.kind, risk_class: candidate.risk_class },
    });
    const evidenceId = candidateEvidenceId(id);
    let active;
    try {
      await this.governance.transitionEvidence(evidenceId, 'active', {
        reasonCode: 'candidate_promoted', evidenceRefs: sources.map((item) => item.id),
      });
      active = this.store.transitionCandidate(id, 'active');
    } catch (error) {
      const evidence = this.governance.evidence(evidenceId);
      if (evidence?.state === 'active' && this.store.candidate(id)?.state !== 'active') {
        await this.governance.transitionEvidence(evidenceId, 'quarantined', {
          reasonCode: 'candidate_promotion_compensated', evidenceRefs: sources.map((item) => item.id),
        }).catch(() => undefined);
      }
      await this.governance.settleDecision(decision.id, {
        status: 'failed', effectCertainty: 'unknown',
        resultFingerprint: governanceFingerprint(`${id}:promotion_failed`),
        reasonCode: error.code ?? 'candidate_promotion_failed',
      });
      throw error;
    }
    await settlePromotionApplied(this.governance, decision.id, id);
    this.#telemetry('learning.promotion', 'succeeded', active, 'candidate_activated');
    return active;
  }

  async reject(id, reason) {
    const candidate = this.store.transitionCandidate(id, 'rejected', { reason });
    const evidence = this.governance.evidence(candidateEvidenceId(id));
    if (evidence && !['invalidated', 'expired', 'superseded'].includes(evidence.state)) {
      await this.governance.transitionEvidence(evidence.id, 'invalidated', { reasonCode: 'candidate_rejected' });
    }
    await this.governance.decide({
      id: newId('learning_rejection'), domain: domainFor(candidate.kind),
      subjectRef: candidate.id, subjectFingerprint: candidate.payload_fingerprint,
      outcome: 'reject', reasonCode: 'candidate_rejected', policyVersion: LEARNING_POLICY_VERSION,
      evidenceRefs: [], authorityRefs: [], decidedAt: Date.now(), expiresAt: null,
      attributes: { candidate_kind: candidate.kind },
    });
    this.#telemetry('learning.candidate', 'denied', candidate, 'candidate_rejected');
    return candidate;
  }

  #requireCandidate(id) {
    const candidate = this.store.candidate(id);
    if (!candidate) throw new ContractError('dream_candidate_missing', 'candidate does not exist');
    return candidate;
  }

  #usableEvidence(refs) {
    if (!Array.isArray(refs) || refs.length === 0) throw new ContractError('learning_evidence_required', 'learning candidates require evidence');
    return refs.map((id) => {
      const evidence = this.governance.evidence(id);
      if (!evidence) throw new ContractError('learning_evidence_missing', 'candidate evidence does not exist');
      if (!['active', 'stale'].includes(evidence.state) || evidence.conflict !== 'none') {
        throw new ContractError('learning_evidence_ineligible', 'candidate evidence is quarantined, conflicting, or invalid');
      }
      return evidence;
    });
  }

  #authorities(refs) {
    if (!Array.isArray(refs) || refs.length === 0) throw new ContractError('learning_authority_required', 'promotion requires explicit authority');
    return refs.map((id) => {
      const evidence = this.governance.evidence(id);
      if (!evidence || evidence.trust !== 'authority' || evidence.state !== 'active') {
        throw new ContractError('learning_authority_invalid', 'promotion authority is missing or inactive');
      }
      return evidence;
    });
  }

  #telemetry(event, status, candidate, reasonCode) {
    this.telemetry?.record(event, status, {
      candidate_id: candidate.id, candidate_kind: candidate.kind,
      candidate_state: candidate.state, payload_fingerprint: candidate.payload_fingerprint,
    }, { reasonCode });
  }
}

function candidateEvidenceId(id) { return `evidence:candidate:${id}`; }
function domainFor(kind) { return kind.startsWith('guidance.') ? 'guidance_promotion' : 'learning_promotion'; }

async function settlePromotionApplied(governance, decisionId, candidateId) {
  await governance.settleDecision(decisionId, {
    status: 'applied', effectCertainty: 'completed',
    resultFingerprint: governanceFingerprint(`${candidateId}:active`), reasonCode: 'candidate_activated',
  });
}

function optionalTimestamp(value, label) {
  return value === null || value === undefined ? null : requiredTimestamp(value, label);
}

function requiredTimestamp(value, label) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new ContractError('learning_timestamp_invalid', `${label} timestamp is invalid`);
  return timestamp;
}

function assertDependencies(options) {
  if (!options?.store || typeof options.store.observeCandidate !== 'function' || typeof options.store.transitionCandidate !== 'function') {
    throw new ContractError('learning_store_required', 'learning candidate store is required');
  }
  if (!options.governance || typeof options.governance.evidence !== 'function'
      || typeof options.governance.registerEvidence !== 'function' || typeof options.governance.decide !== 'function') {
    throw new ContractError('learning_governance_required', 'learning governance engine is required');
  }
}
