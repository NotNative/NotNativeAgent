// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { verifyDesktopClearedAdmissionUnderOwnership } from './desktop-activation-retirement-cleanup.js';
import { transferDesktopTrialAdmissionGate } from './desktop-trial-admission.js';

/** Consume exact clearance while the retained service and registry leases are held. */
export async function transferRetainedNativeAdmission(state, registryLease, options) {
  if (!state.unpublishedTrial || !state.retainedLeaseArmed || !state.trialAdmissionGate
    || state.nativeAdmissionTransferred) {
    throw new ContractError('desktop_trial_admission_invalid', 'desktop retained native admission cannot transfer');
  }
  return verifyDesktopClearedAdmissionUnderOwnership(state.identity, state, state.lease,
    registryLease, options, proof => {
      const result = transferDesktopTrialAdmissionGate(state.trialAdmissionGate, state.identity, registryLease, proof);
      state.nativeAdmissionTransferred = true;
      return result;
    });
}
