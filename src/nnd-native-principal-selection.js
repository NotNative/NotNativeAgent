// SPDX-License-Identifier: Apache-2.0
/** Same-process proof selection and quarantined promotion. */
import { ContractError } from './ids.js';
import { assertNndTrialOwnership } from './nnd-trial-admission.js';
import { consumeNndPrincipalTransitionProof } from './nnd-activation-principal-proof.js';
import { consumeNndHeldTicketConfirmation } from './nnd-activation-held-ticket.js';

const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND native principal transition is unavailable; preserve the activation barrier.');

function promoteSelected(entry, native, state, serviceLease, registryLease, options) {
  const { identity, trialGate, selectedState, selectedServiceLease, selectedRegistryLease, confirmed, promoted } = entry;
  if (promoted || !confirmed || state !== selectedState || state?.native !== native
    || !native?.isListening?.() || state.controller?.isListening?.() !== true
    || state.lease !== serviceLease || serviceLease !== selectedServiceLease
    || registryLease !== selectedRegistryLease
    || options?.operationId !== confirmed.operation_id
    || options?.stageOperationId !== confirmed.stage_operation_id
    || options?.generation !== confirmed.generation) throw invalid();
  assertNndTrialOwnership(trialGate, identity);
  if (state.nativePrincipalPromoted || state.published || state.stopping) throw invalid();
  // Security: admission enters health-only quarantine in the same synchronous turn.
  state.nativePrincipalPromoted = true;
  return Object.freeze({ state: 'native_principal_promoted_unresolved',
    operation_id: confirmed.operation_id, generation: confirmed.generation,
    ticket_receipt_sha256: confirmed.ticket_receipt_sha256 });
}

export function createNndNativePrincipalSelection(identity, trialGate) {
  let selected = null, selectedState = null;
  let selectedServiceLease = null, selectedRegistryLease = null;
  let confirmed = null, promoted = false;
  return Object.freeze({
    select(native, proof, state, serviceLease, registryLease, options) {
      if (selected || !state || state.native !== native || !native?.isListening?.()) throw invalid();
      assertNndTrialOwnership(trialGate, identity);
      const evidence = consumeNndPrincipalTransitionProof(proof, identity, state,
        serviceLease, registryLease, options);
      // There is no await between proof consumption and this second owner check.
      assertNndTrialOwnership(trialGate, identity);
      selected = evidence;
      selectedState = state;
      selectedServiceLease = serviceLease;
      selectedRegistryLease = registryLease;
      return evidence;
    },
    evidence(native, state) {
      if (state !== selectedState || state?.native !== native || !selected || !native.isListening?.()) return null;
      assertNndTrialOwnership(trialGate, identity);
      return selected;
    },
    confirmTicket(native, proof, state, serviceLease, registryLease, options) {
      if (confirmed || state !== selectedState || state?.native !== native || !native?.isListening?.()
        || state.controller?.isListening?.() !== true
        || serviceLease !== selectedServiceLease || registryLease !== selectedRegistryLease) throw invalid();
      assertNndTrialOwnership(trialGate, identity);
      const evidence = consumeNndHeldTicketConfirmation(proof, identity, state,
        serviceLease, registryLease, options);
      if (!selected || selected.operation_id !== evidence.operation_id
        || selected.stage_operation_id !== evidence.stage_operation_id
        || selected.generation !== evidence.generation
        || selected.registration_revision !== evidence.registration_revision
        || selected.journal_sha256 !== evidence.publication_sha256
        || selected.native_state !== evidence.native_state) throw invalid();
      assertNndTrialOwnership(trialGate, identity);
      confirmed = evidence;
      return evidence;
    },
    confirmedTicket(native, state) {
      if (!confirmed || state !== selectedState || state?.native !== native || !native.isListening?.()
        || state.controller?.isListening?.() !== true) return null;
      assertNndTrialOwnership(trialGate, identity);
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
      assertNndTrialOwnership(trialGate, identity);
      return selectedState?.nativePrincipalPromoted === true;
    },
  });
}
