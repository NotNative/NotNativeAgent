// SPDX-License-Identifier: Apache-2.0
/** Fresh private UI attach after quarantined same-process principal promotion. */
import { ContractError } from './ids.js';
import { withNndServiceLease } from './nnd-service-lock.js';
import { runManifestLeaseWork } from './persistence/manifest-lock.js';
import { assertNndAttach } from './nnd-service-attach.js';
import { readNndPrivateTicketReceiptUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';
import { redeemNndPrivateTicket } from './nnd-activation-private-ticket.js';

const USED = new WeakSet();
const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'Promoted NND private attach is unresolved; preserve the barrier and both owners.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function selected(identity, state, serviceLease, options, receipt, allowUsed = false) {
  if (!allowUsed && USED.has(state) || state.identity !== identity || state.lease !== serviceLease
    || !state.nativePrincipalPromoted || state.published || state.stopping
    || state.child?.failed || !state.child?.child || state.child.child.exitCode !== null
    || state.controller?.isListening?.() !== true || state.native?.isListening?.() !== true) throw invalid();
  const evidence = state.native.promotedPrincipalEvidence?.(state);
  if (!evidence || evidence.operation_id !== options.operationId
    || evidence.stage_operation_id !== options.stageOperationId || evidence.generation !== options.generation
    || evidence.registration_revision !== receipt.registration_revision
    || evidence.publication_sha256 !== receipt.publication_sha256
    || evidence.ticket_receipt_sha256 !== receipt.receipt_sha256) throw invalid();
  return evidence;
}
async function issueAndRedeem(identity, state, options, signal) {
  USED.add(state); // Security: an unknown child IPC or HTTP outcome cannot be replayed.
  const frame = await state.child.command('issue_ui_ticket');
  if (!exact(frame, ['type', 'protocol', 'generation', 'request_id', 'ticket', 'expires_at'])
    || frame.type !== 'ui_ticket' || frame.protocol !== '1.0' || frame.generation !== options.generation
    || typeof frame.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(frame.request_id)) throw invalid();
  assertNndAttach({ protocol: '1.0', installation_id: identity.installation_id,
    data_id: identity.data_id, generation: options.generation, endpoint: state.ui,
    ticket: frame.ticket, expires_at: frame.expires_at }, state.record);
  await redeemNndPrivateTicket(state.ui, frame.ticket, signal);
}

/** Returns only unresolved evidence; controller routes and native mutations stay closed. */
export async function probeNndPromotedPrivateAttachUnderOwnership(identity, state, serviceLease, registryLease, options) {
  if (!identity || !state || !options || Object.keys(options).some(key =>
    !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    // Why: the installed Windows helper census can take far longer than the
    // synthetic fixture; both full health passes must fit before completion.
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      const receipt = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
      if (receipt.state !== 'private_ticket_recorded_unresolved') throw invalid();
      const evidence = selected(identity, state, serviceLease, options, receipt);
      const before = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      if (before.registration_revision !== receipt.registration_revision
        || before.journal_sha256 !== receipt.publication_sha256
        || before.native_state !== evidence.native_state) throw invalid();
      selected(identity, state, serviceLease, options, receipt);
      await issueAndRedeem(identity, state, options, signal);
      const after = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      const reopened = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
      if (after.registration_revision !== before.registration_revision || after.journal_sha256 !== before.journal_sha256
        || after.native_state !== before.native_state || reopened.receipt_sha256 !== receipt.receipt_sha256
        || selected(identity, state, serviceLease, options, reopened, true) !== evidence) throw invalid();
      signal.throwIfAborted();
      return Object.freeze({ state: 'promoted_private_attach_verified_unresolved', operation_id: options.operationId,
        generation: options.generation, registration_revision: receipt.registration_revision,
        ticket_receipt_sha256: receipt.receipt_sha256, native_state: after.native_state });
    } catch { throw invalid(); }
  }), { timeoutMs: 600000 });
}
