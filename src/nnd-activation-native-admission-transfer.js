// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { verifyNndClearedAdmissionUnderOwnership } from './nnd-activation-retirement-cleanup.js';
import { transferNndTrialAdmissionGate } from './nnd-trial-admission.js';

/** Consume exact clearance while the retained service and registry leases are held. */
export async function transferRetainedNativeAdmission(state, registryLease, options) {
  if (!state.unpublishedTrial || !state.retainedLeaseArmed || !state.trialAdmissionGate
    || state.nativeAdmissionTransferred) {
    throw new ContractError('nnd_trial_admission_invalid', 'NND retained native admission cannot transfer');
  }
  return verifyNndClearedAdmissionUnderOwnership(state.identity, state, state.lease,
    registryLease, options, proof => {
      const result = transferNndTrialAdmissionGate(state.trialAdmissionGate, state.identity, registryLease, proof);
      state.nativeAdmissionTransferred = true;
      return result;
    });
}
