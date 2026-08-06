// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './governance-contracts.js';
import { newId } from './ids.js';

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

  async #recordEvidence(item, assessment, context) {
    if (!this.governance) return null;
    const contentFingerprint = governanceFingerprint(item.content);
    const sourceVersion = `${item.source}:${item.id}:${item.updatedAt}:${contentFingerprint}`;
    return this.governance.registerEvidence({
      id: `evidence:memory:${governanceFingerprint(sourceVersion)}`,
      kind: 'memory_recall', origin: 'memory', trust: 'untrusted',
      state: assessment.state, freshness: assessment.freshness, conflict: assessment.conflict,
      sourceRef: `memory:${item.id}`, sourceFingerprint: sourceVersion, contentFingerprint,
      scope: scopeRecord(item.scope), observedAt: observedAt(item),
      attributes: {
        request_id: context.requestId ?? null,
        relevance: item.relevance,
        pinned: item.pinned,
        assertion_mode: assessment.assertionMode,
      },
    });
  }

  async #recordDecision(item, assessment, evidence, context) {
    if (!this.governance || !evidence) return null;
    return this.governance.decide({
      id: newId('governance_decision'), domain: 'memory_eligibility',
      subjectRef: `memory:${item.id}`, subjectFingerprint: evidence.contentFingerprint,
      outcome: assessment.admit ? 'admit' : assessment.outcome,
      reasonCode: assessment.reasonCode, policyVersion: GROUNDING_POLICY_VERSION,
      evidenceRefs: [evidence.id], authorityRefs: context.authorityRef ? [context.authorityRef] : [],
      attributes: { request_id: context.requestId ?? null, assertion_mode: assessment.assertionMode },
    });
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
  return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}
