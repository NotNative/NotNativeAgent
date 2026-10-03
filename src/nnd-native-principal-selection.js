// SPDX-License-Identifier: Apache-2.0
/** Same-process proof selection. Authority stays at trial scope until terminal admission exists. */
import { ContractError } from './ids.js';
import { assertNndTrialRequestAdmission } from './nnd-trial-admission.js';
import { consumeNndPrincipalTransitionProof } from './nnd-activation-principal-proof.js';
import { consumeNndHeldTicketConfirmation } from './nnd-activation-held-ticket.js';

const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND native principal transition is unavailable; preserve the activation barrier.');

export function createNndNativePrincipalSelection(identity, trialGate) {
  let selected = null;
  let selectedState = null;
  let confirmed = null;
  return Object.freeze({
    select(native, proof, state, serviceLease, registryLease, options) {
      if (selected || !state || state.native !== native || !native?.isListening?.()) throw invalid();
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      const evidence = consumeNndPrincipalTransitionProof(proof, identity, state,
        serviceLease, registryLease, options);
      // There is no await between proof consumption and this second owner check.
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      selected = evidence;
      selectedState = state;
      return evidence;
    },
    evidence(native, state) {
      if (state !== selectedState || state?.native !== native || !selected || !native.isListening?.()) return null;
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      return selected;
    },
    confirmTicket(native, proof, state, serviceLease, registryLease, options) {
      if (confirmed || state !== selectedState || state?.native !== native || !native?.isListening?.()
        || state.controller?.isListening?.() !== true) throw invalid();
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      const evidence = consumeNndHeldTicketConfirmation(proof, identity, state,
        serviceLease, registryLease, options);
      if (!selected || selected.operation_id !== evidence.operation_id
        || selected.stage_operation_id !== evidence.stage_operation_id
        || selected.generation !== evidence.generation
        || selected.registration_revision !== evidence.registration_revision
        || selected.journal_sha256 !== evidence.publication_sha256
        || selected.native_state !== evidence.native_state) throw invalid();
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      confirmed = evidence;
      return evidence;
    },
    confirmedTicket(native, state) {
      if (!confirmed || state !== selectedState || state?.native !== native || !native.isListening?.()
        || state.controller?.isListening?.() !== true) return null;
      assertNndTrialRequestAdmission(trialGate, identity, { method: 'GET' });
      return confirmed;
    },
  });
}
