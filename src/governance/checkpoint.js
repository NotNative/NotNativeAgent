// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { governanceFingerprint, normalizeGovernanceEvidence } from './contracts.js';

export function evidenceEntry(evidence, lifecycle = null) {
  const registration = normalizeGovernanceEvidence(evidence);
  if (lifecycle && (!Number.isSafeInteger(lifecycle.transitionCount) || lifecycle.transitionCount < 0
    || !/^[a-f0-9]{64}$/u.test(lifecycle.transitionFingerprint))) {
    throw new ContractError('governance_checkpoint_invalid', 'evidence checkpoint lifecycle is invalid');
  }
  return {
    registration,
    record: lifecycle ? normalizeGovernanceEvidence({ ...registration, state: lifecycle.state }) : registration,
    transitionCount: lifecycle?.transitionCount ?? 0,
    transitionFingerprint: lifecycle?.transitionFingerprint ?? governanceFingerprint(registration),
  };
}

export function evidenceCheckpoint(entry) {
  // Invariant: checkpoint state never replaces the immutable registration identity.
  // Older runtimes reject this record type rather than silently revive its initial state.
  return { type: 'evidence_checkpoint', payload: {
    evidence: entry.registration,
    lifecycle: { state: entry.record.state, transitionCount: entry.transitionCount,
      transitionFingerprint: entry.transitionFingerprint },
  } };
}
