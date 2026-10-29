// SPDX-License-Identifier: Apache-2.0
/** Same-process proof selection and quarantined promotion. */
import { ContractError } from './ids.js';
import { assertDesktopTrialOwnership } from './desktop-trial-admission.js';
import { consumeDesktopPrincipalTransitionProof } from './desktop-activation-principal-proof.js';
import { consumeDesktopHeldTicketConfirmation } from './desktop-activation-held-ticket.js';

const invalid = () => new ContractError('desktop_activation_transition_proof_invalid',
  'desktop native principal transition is unavailable; preserve the activation barrier.');

function promoteSelected(entry, native, state, serviceLease, registryLease, options) {
  const { identity, trialGate, selectedState, selectedServiceLease, selectedRegistryLease, confirmed, promoted } = entry;
  if (promoted || !confirmed || state !== selectedState || state?.native !== native
    || !native?.isListening?.() || state.controller?.isListening?.() !== true
    || state.lease !== serviceLease || serviceLease !== selectedServiceLease
    || registryLease !== selectedRegistryLease
    || options?.operationId !== confirmed.operation_id
    || options?.stageOperationId !== confirmed.stage_operation_id
    || options?.generation !== confirmed.generation) throw invalid();
  assertDesktopTrialOwnership(trialGate, identity);
  if (state.nativePrincipalPromoted || state.published || state.stopping) throw invalid();
  // Security: admission enters health-only quarantine in the same synchronous turn.
  state.nativePrincipalPromoted = true;
  return Object.freeze({ state: 'native_principal_promoted_unresolved',
    operation_id: confirmed.operation_id, generation: confirmed.generation,
    ticket_receipt_sha256: confirmed.ticket_receipt_sha256 });
}

export function createDesktopNativePrincipalSelection(identity, trialGate) {
  let selected = null, selectedState = null;
  let selectedServiceLease = null, selectedRegistryLease = null;
  let confirmed = null, promoted = false;
  return Object.freeze({
    select(native, proof, state, serviceLease, registryLease, options) {
      if (selected || !state || state.native !== native || !native?.isListening?.()) throw invalid();
      assertDesktopTrialOwnership(trialGate, identity);
      const evidence = consumeDesktopPrincipalTransitionProof(proof, identity, state,
        serviceLease, registryLease, options);
      // There is no await between proof consumption and this second owner check.
      assertDesktopTrialOwnership(trialGate, identity);
      selected = evidence;
      selectedState = state;
      selectedServiceLease = serviceLease;
      selectedRegistryLease = registryLease;
      return evidence;
    },
    evidence(native, state) {
      if (state !== selectedState || state?.native !== native || !selected || !native.isListening?.()) return null;
      assertDesktopTrialOwnership(trialGate, identity);
      return selected;
    },
    confirmTicket(native, proof, state, serviceLease, registryLease, options) {
      if (confirmed || state !== selectedState || state?.native !== native || !native?.isListening?.()
        || state.controller?.isListening?.() !== true
        || serviceLease !== selectedServiceLease || registryLease !== selectedRegistryLease) throw invalid();
      assertDesktopTrialOwnership(trialGate, identity);
      const evidence = consumeDesktopHeldTicketConfirmation(proof, identity, state,
        serviceLease, registryLease, options);
      if (!selected || selected.operation_id !== evidence.operation_id
        || selected.stage_operation_id !== evidence.stage_operation_id
        || selected.generation !== evidence.generation
        || selected.registration_revision !== evidence.registration_revision
        || selected.journal_sha256 !== evidence.publication_sha256
        || selected.native_state !== evidence.native_state) throw invalid();
      assertDesktopTrialOwnership(trialGate, identity);
      confirmed = evidence;
      return evidence;
    },
    confirmedTicket(native, state) {
      if (!confirmed || state !== selectedState || state?.native !== native || !native.isListening?.()
        || state.controller?.isListening?.() !== true) return null;
      assertDesktopTrialOwnership(trialGate, identity);
      return confirmed;
    },
    promote(native, state, serviceLease, registryLease, options) {
      const result = promoteSelected({ identity, trialGate, selectedState, selectedServiceLease,
        selectedRegistryLease, confirmed, promoted }, native, state, serviceLease, registryLease, options);
      promoted = true;
      return result;
    },
    promoted() {
      if (!promoted) return false;
      assertDesktopTrialOwnership(trialGate, identity);
      return selectedState?.nativePrincipalPromoted === true;
    },
  });
}
