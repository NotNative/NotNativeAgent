// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './contracts.js';
import { ContractError, newId } from '../ids.js';

export const GROUNDING_POLICY_VERSION = 'grounding/1';

export class GroundingPolicy {
  constructor(options = {}) {
    this.governance = options.governance ?? null;
    this.telemetry = options.telemetry ?? null;
  }

  async admitMemory(items, context = {}) {
    const admitted = [];
    const rejected = [];
    for (const item of items) {
      const assessment = assessMemory(item);
      const evidence = await this.#recordEvidence(item, assessment, context);
      const decision = await this.#recordDecision(item, assessment, evidence, context);
      const governed = Object.freeze({
        ...item,
        labels: Object.freeze([...new Set([...(item.labels ?? []), ...assessment.labels])]),
        grounding: Object.freeze({
          assertionMode: assessment.assertionMode,
          evidenceId: evidence?.id ?? null,
          decisionId: decision?.id ?? null,
          reasonCode: assessment.reasonCode,
          policyVersion: GROUNDING_POLICY_VERSION,
        }),
      });
      if (assessment.admit) admitted.push(governed);
      else rejected.push(Object.freeze({ id: item.id, reasonCode: assessment.reasonCode, evidenceId: evidence?.id ?? null }));
    }
    this.telemetry?.record('grounding.memory', 'completed', {
      request_id: context.requestId ?? null,
      admitted: admitted.length,
      rejected: rejected.length,
      policy_version: GROUNDING_POLICY_VERSION,
    }, { outcome: rejected.length > 0 ? 'qualified' : 'admitted' });
    return Object.freeze({ admitted: Object.freeze(admitted), rejected: Object.freeze(rejected) });
  }

  async admitProjectGuidance(items, context = {}) {
    return this.#admitContext(items, context, {
      kind: 'project_guidance', origin: 'workspace_guidance', trust: 'configured',
      source: (item) => `project_guidance:${item.path}`,
      content: (item) => item.content,
      scope: () => context.scope ?? 'project:workspace',
      reasonCode: 'workspace_guidance_admitted', assertionMode: 'behavioral_guidance',
    });
  }

  async admitHook(items, context = {}) {
    return this.#admitContext(items, context, {
      kind: 'hook_context', origin: 'hook', trust: 'untrusted',
      source: (item) => `hook:${item.source}`,
      content: (item) => item.content,
      scope: () => context.scope ?? 'session:active',
      reasonCode: 'hook_context_qualified', assertionMode: 'qualified',
    });
  }

  async #admitContext(items, context, policy) {
    if (!this.governance
      || typeof this.governance.registerEvidence !== 'function'
      || typeof this.governance.decide !== 'function') {
      throw new ContractError('governance_evidence_invalid', 'context grounding governance is unavailable');
    }
    const admitted = [];
    for (const item of items) {
      const sourceRef = policy.source(item);
      const contentFingerprint = governanceFingerprint(policy.content(item));
      const evidence = await this.governance.registerEvidence({
        id: policy.origin === 'hook' ? newId('evidence')
          : `evidence:${policy.kind}:${governanceFingerprint(`${sourceRef}:${contentFingerprint}`)}`,
        kind: policy.kind, origin: policy.origin, trust: policy.trust,
        state: 'active', freshness: policy.origin === 'hook' ? 'unknown' : 'not_applicable', conflict: 'none',
        sourceRef, sourceFingerprint: sourceRef, contentFingerprint,
        scope: scopeRecord(policy.scope()), observedAt: observedAt(item),
        attributes: { assertion_mode: policy.assertionMode, turn_id: context.turnId ?? null },
      });
      validateEvidence(evidence);
      await this.#supersedePrior(sourceRef, evidence);
      const decision = await this.governance.decide({
        domain: 'evidence_admission', subjectRef: sourceRef,
        subjectFingerprint: contentFingerprint, outcome: 'admit', reasonCode: policy.reasonCode,
        policyVersion: GROUNDING_POLICY_VERSION, evidenceRefs: [evidence.id],
        authorityRefs: context.authorityRef ? [context.authorityRef] : [],
        attributes: { assertion_mode: policy.assertionMode, turn_id: context.turnId ?? null },
      });
      validateDecision(decision);
      admitted.push(Object.freeze({
        ...item,
        grounding: Object.freeze({
          assertionMode: policy.assertionMode, evidenceId: evidence.id,
          reasonCode: policy.reasonCode, policyVersion: GROUNDING_POLICY_VERSION,
          observedAt: observedAt(item), freshness: policy.origin === 'hook' ? 'unknown' : 'not_applicable',
        }),
      }));
    }
    return Object.freeze({ admitted: Object.freeze(admitted), rejected: Object.freeze([]) });
  }

  async #recordEvidence(item, assessment, context) {
    if (!this.governance) return null;
    const contentFingerprint = governanceFingerprint(item.content);
    const sourceVersion = governanceFingerprint({
      source: item.source,
      id: item.id,
      scope: item.scope,
      contentFingerprint,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      pinned: item.pinned,
      stale: item.stale,
      conflict: item.conflict,
    });
    const evidence = await this.governance.registerEvidence({
      id: `evidence:memory:${sourceVersion}`,
      kind: 'memory_recall', origin: 'memory', trust: 'untrusted',
      state: assessment.state, freshness: assessment.freshness, conflict: assessment.conflict,
      sourceRef: `memory:${item.id}`, sourceFingerprint: sourceVersion, contentFingerprint,
      scope: scopeRecord(item.scope), observedAt: observedAt(item),
      attributes: {
        pinned: item.pinned,
        assertion_mode: assessment.assertionMode,
      },
    });
    validateEvidence(evidence);
    await this.#supersedePrior(`memory:${item.id}`, evidence);
    return evidence;
  }

  async #recordDecision(item, assessment, evidence, context) {
    if (!this.governance || !evidence) return null;
    const decision = await this.governance.decide({
      id: newId('governance_decision'), domain: 'memory_eligibility',
      subjectRef: `memory:${item.id}`, subjectFingerprint: evidence.contentFingerprint,
      outcome: assessment.admit ? 'admit' : assessment.outcome,
      reasonCode: assessment.reasonCode, policyVersion: GROUNDING_POLICY_VERSION,
      evidenceRefs: [evidence.id], authorityRefs: context.authorityRef ? [context.authorityRef] : [],
      attributes: {
        request_id: context.requestId ?? null,
        relevance: item.relevance,
        pinned: item.pinned,
        assertion_mode: assessment.assertionMode,
      },
    });
    validateDecision(decision);
    return decision;
  }

  async #supersedePrior(sourceRef, current) {
    const priorEvidence = this.governance.evidenceBySource(sourceRef);
    if (!Array.isArray(priorEvidence)) {
      throw new ContractError('governance_evidence_invalid', 'governance evidence lookup returned an invalid result');
    }
    for (const prior of priorEvidence) {
      if (prior.id === current.id || ['superseded', 'invalidated', 'expired'].includes(prior.state)) continue;
      await this.governance.transitionEvidence(prior.id, 'superseded', {
        reasonCode: 'source_version_replaced', evidenceRefs: [current.id],
      });
    }
  }
}

function validateEvidence(value) {
  if (!value || typeof value.id !== 'string' || typeof value.contentFingerprint !== 'string') {
    throw new ContractError('governance_evidence_invalid', 'governance evidence registration returned an invalid result');
  }
}

function validateDecision(value) {
  if (!value || typeof value.id !== 'string') {
    throw new ContractError('governance_decision_invalid', 'governance decision registration returned an invalid result');
  }
}

function assessMemory(item) {
  if (item.conflict === true) return Object.freeze({
    admit: false, outcome: 'quarantine', reasonCode: 'memory_conflict_confirmed',
    assertionMode: 'prohibited', state: 'conflicting', freshness: item.stale ? 'stale' : 'unknown',
    conflict: 'confirmed', labels: ['quarantined'],
  });
  if (item.stale === true) return Object.freeze({
    admit: true, outcome: 'admit', reasonCode: 'memory_historical_only',
    assertionMode: 'historical_only', state: 'stale', freshness: 'stale',
    conflict: 'none', labels: ['historical-only'],
  });
  if (item.updatedAt <= 0) return Object.freeze({
    admit: true, outcome: 'admit', reasonCode: 'memory_freshness_unknown',
    assertionMode: 'qualified', state: 'active', freshness: 'unknown',
    conflict: 'none', labels: ['freshness-unknown'],
  });
  return Object.freeze({
    admit: true, outcome: 'admit', reasonCode: 'memory_eligible',
    assertionMode: 'assertable_with_attribution', state: 'active', freshness: 'current',
    conflict: 'none', labels: [],
  });
}

function scopeRecord(scope) {
  const kind = scope.startsWith('project:') ? 'project' : scope === 'user' ? 'user' : 'external';
  return { kind, fingerprint: governanceFingerprint(scope) };
}

function observedAt(item) {
  const value = item.updatedAt || item.createdAt;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
