// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './governance/contracts.js';

export async function admitNnmReceipt(engine, receipt, workspaceRoot) {
  const evidence = await engine.governance.registerEvidence({
    id: `evidence:nnm-receipt:${receipt.receipt_id}`,
    kind: 'nnm_turn_analysis_receipt', origin: 'hook', trust: 'observed',
    state: 'active', freshness: 'current', conflict: 'none', sourceRef: `nnm:${receipt.receipt_id}`,
    sourceFingerprint: receipt.receipt_id, contentFingerprint: governanceFingerprint(receipt),
    scope: { kind: 'workspace', fingerprint: governanceFingerprint(workspaceRoot) },
    observedAt: Date.parse(receipt.completed_at), attributes: {
      stored: receipt.stored, facts_stored: receipt.facts_stored,
      relationships_stored: receipt.relationships_stored, candidates: receipt.candidates,
      summary_stored: receipt.summary_stored,
    },
  });
  const decision = await engine.governance.decide({
    id: `governance:nnm-receipt:${receipt.receipt_id}`, domain: 'memory_eligibility',
    subjectRef: `turn:${receipt.turn_id}`, subjectFingerprint: receipt.receipt_id,
    outcome: 'admit', reasonCode: 'nnm_effect_receipt_verified', policyVersion: 'nnm-reconciliation/1',
    evidenceRefs: [evidence.id], authorityRefs: [], decidedAt: Date.parse(receipt.completed_at),
    expiresAt: null, attributes: { stored: receipt.stored, candidates: receipt.candidates },
  });
  await engine.governance.settleDecision(decision.id, {
    status: 'applied', effectCertainty: 'completed', resultFingerprint: receipt.receipt_id,
    reasonCode: 'nnm_effects_attributed',
  });
}

export async function admitHygieneReceipt(engine, receipt, workspaceRoot) {
  const evidence = await engine.governance.registerEvidence({
    id: `evidence:nnm-hygiene:${receipt.receipt_id}`,
    kind: 'nnm_hygiene_receipt', origin: 'hook', trust: 'observed',
    state: 'active', freshness: 'current', conflict: 'none',
    sourceRef: `nnm-hygiene:${receipt.receipt_id}`, sourceFingerprint: receipt.receipt_id,
    contentFingerprint: governanceFingerprint(receipt),
    scope: { kind: 'workspace', fingerprint: governanceFingerprint(workspaceRoot) },
    observedAt: Date.parse(receipt.completed_at), attributes: {
      candidates: receipt.candidates,
      categories_fingerprint: governanceFingerprint(receipt.categories),
    },
  });
  const decision = await engine.governance.decide({
    id: `governance:nnm-hygiene:${receipt.receipt_id}`, domain: 'memory_eligibility',
    subjectRef: `nnm-hygiene:${receipt.receipt_id}`, subjectFingerprint: receipt.receipt_id,
    outcome: receipt.candidates > 0 ? 'defer' : 'admit',
    reasonCode: receipt.candidates > 0 ? 'hygiene_review_required' : 'hygiene_no_candidates',
    policyVersion: 'nnm-hygiene/1', evidenceRefs: [evidence.id], authorityRefs: [],
    decidedAt: Date.parse(receipt.completed_at), expiresAt: null,
    attributes: { candidates: receipt.candidates },
  });
  await engine.governance.settleDecision(decision.id, {
    status: 'applied', effectCertainty: 'completed', resultFingerprint: receipt.receipt_id,
    reasonCode: 'hygiene_scan_attributed',
  });
  return evidence;
}
