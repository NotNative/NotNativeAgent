// SPDX-License-Identifier: Apache-2.0
/** Private live bridge from the durable ticket receipt to the existing one-use principal proof. */
import { ContractError } from './ids.js';
import { readNndPrivateTicketReceiptUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';
import { consumeNndPrincipalTransitionProof } from './nnd-activation-principal-proof.js';

const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND held-live ticket transition is unresolved; preserve the pending barrier and both owners.');

/** This cannot publish, promote, clear the barrier, or transfer the lease. */
export async function verifyNndHeldTicketUnderOwnership(identity, state, serviceLease, registryLease, options) {
  if (!identity || !state || !options || Object.keys(options).some(key =>
    !['operationId', 'stageOperationId', 'generation', 'signal', 'fetchImpl', 'timeoutMs'].includes(key))) throw invalid();
  try {
    const before = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
    if (before.state !== 'private_ticket_recorded_unresolved') throw invalid();
    let consumed;
    const health = await verifyNndPublishedTrialHealthUnderOwnership(identity, state, serviceLease, registryLease,
      { ...options, afterVerified: ({ proof, health: verified }) => {
        consumed = consumeNndPrincipalTransitionProof(proof, identity, state, serviceLease, registryLease, options);
        if (consumed.registration_revision !== before.registration_revision
          || consumed.journal_sha256 !== before.publication_sha256
          || verified.registration_revision !== before.registration_revision
          || verified.journal_sha256 !== before.publication_sha256) throw invalid();
      } });
    const after = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
    if (!consumed || after.state !== before.state || after.receipt_sha256 !== before.receipt_sha256
      || after.registration_revision !== before.registration_revision
      || after.publication_sha256 !== before.publication_sha256
      || health.registration_revision !== before.registration_revision
      || health.journal_sha256 !== before.publication_sha256) throw invalid();
    options.signal?.throwIfAborted();
    return Object.freeze({ state: 'held_private_ticket_verified_unresolved',
      operation_id: options.operationId, generation: options.generation,
      registration_revision: before.registration_revision,
      publication_sha256: before.publication_sha256, ticket_receipt_sha256: before.receipt_sha256,
      native_state: health.native_state });
  } catch { throw invalid(); }
}
