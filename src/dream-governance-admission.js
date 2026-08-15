// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './governance/contracts.js';
import { ContractError } from './ids.js';

const MEMORY_ELIGIBILITY_DOMAIN = 'memory_eligibility';
const NNM_RECONCILIATION_POLICY = 'nnm-reconciliation/1';
const NNM_HYGIENE_POLICY = 'nnm-hygiene/1';

/** Admit one validated NNM turn-analysis receipt into durable governance evidence. */
export async function admitNnmReceipt(engine, receipt, workspaceRoot) {
  const completedAt = validateReceipt(receipt, workspaceRoot, 'nnm_receipt_invalid');
  const counts = ['stored', 'facts_stored', 'relationships_stored', 'candidates'];
  if (typeof receipt.turn_id !== 'string' || receipt.turn_id.length === 0
    || counts.some((key) => !Number.isSafeInteger(receipt[key]) || receipt[key] < 0)
    || typeof receipt.summary_stored !== 'boolean') {
    throw new ContractError('nnm_receipt_invalid', 'NNM turn-analysis receipt fields are invalid');
  }
  return commitAdmission(engine, {
    evidence: {
      id: `evidence:nnm-receipt:${receipt.receipt_id}`,
      kind: 'nnm_turn_analysis_receipt', origin: 'hook', trust: 'observed',
      state: 'active', freshness: 'current', conflict: 'none', sourceRef: `nnm:${receipt.receipt_id}`,
      sourceFingerprint: receipt.receipt_id, contentFingerprint: governanceFingerprint(receipt),
      scope: { kind: 'workspace', fingerprint: governanceFingerprint(workspaceRoot) },
      observedAt: completedAt, attributes: {
        stored: receipt.stored, facts_stored: receipt.facts_stored,
        relationships_stored: receipt.relationships_stored, candidates: receipt.candidates,
        summary_stored: receipt.summary_stored,
      },
    },
    decision: {
      id: `governance:nnm-receipt:${receipt.receipt_id}`, domain: MEMORY_ELIGIBILITY_DOMAIN,
      subjectRef: `turn:${receipt.turn_id}`, subjectFingerprint: receipt.receipt_id,
      outcome: 'admit', reasonCode: 'nnm_effect_receipt_verified', policyVersion: NNM_RECONCILIATION_POLICY,
      authorityRefs: [], decidedAt: completedAt, expiresAt: null,
      attributes: { stored: receipt.stored, candidates: receipt.candidates },
    },
    terminal: {
      status: 'applied', effectCertainty: 'completed', resultFingerprint: receipt.receipt_id,
      reasonCode: 'nnm_effects_attributed',
    },
  });
}

/** Admit one validated NNM hygiene receipt and return its governance evidence. */
export async function admitHygieneReceipt(engine, receipt, workspaceRoot) {
  const completedAt = validateReceipt(receipt, workspaceRoot, 'nnm_hygiene_receipt_invalid');
  if (!Number.isSafeInteger(receipt.candidates) || receipt.candidates < 0) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt candidate count is invalid');
  }
  if (!receipt.categories || typeof receipt.categories !== 'object' || Array.isArray(receipt.categories)) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt categories are invalid');
  }
  return commitAdmission(engine, {
    evidence: {
      id: `evidence:nnm-hygiene:${receipt.receipt_id}`,
      kind: 'nnm_hygiene_receipt', origin: 'hook', trust: 'observed',
      state: 'active', freshness: 'current', conflict: 'none',
      sourceRef: `nnm-hygiene:${receipt.receipt_id}`, sourceFingerprint: receipt.receipt_id,
      contentFingerprint: governanceFingerprint(receipt),
      scope: { kind: 'workspace', fingerprint: governanceFingerprint(workspaceRoot) },
      observedAt: completedAt, attributes: {
        candidates: receipt.candidates,
        categories_fingerprint: governanceFingerprint(receipt.categories),
      },
    },
    decision: {
      id: `governance:nnm-hygiene:${receipt.receipt_id}`, domain: MEMORY_ELIGIBILITY_DOMAIN,
      subjectRef: `nnm-hygiene:${receipt.receipt_id}`, subjectFingerprint: receipt.receipt_id,
      outcome: receipt.candidates > 0 ? 'defer' : 'admit',
      reasonCode: receipt.candidates > 0 ? 'hygiene_review_required' : 'hygiene_no_candidates',
      policyVersion: NNM_HYGIENE_POLICY, authorityRefs: [], decidedAt: completedAt, expiresAt: null,
      attributes: { candidates: receipt.candidates },
    },
    terminal: {
      status: 'applied', effectCertainty: 'completed', resultFingerprint: receipt.receipt_id,
      reasonCode: 'hygiene_scan_attributed',
    },
  });
}

async function commitAdmission(engine, input) {
  const evidence = await engine.governance.registerEvidence(input.evidence);
  const decision = await engine.governance.decide({ ...input.decision, evidenceRefs: [evidence.id] });
  await engine.governance.settleDecision(decision.id, input.terminal);
  return evidence;
}

function validateReceipt(receipt, workspaceRoot, code) {
  const completedAt = Date.parse(receipt?.completed_at);
  if (!receipt || typeof receipt !== 'object' || !/^[a-f0-9]{64}$/u.test(receipt.receipt_id)
    || !Number.isFinite(completedAt) || typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new ContractError(code, 'NNM receipt attribution is invalid');
  }
  return completedAt;
}
