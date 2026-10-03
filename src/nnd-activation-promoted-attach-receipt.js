// SPDX-License-Identifier: Apache-2.0
/** Durable evidence of a past promoted private attach, never a completed service. */
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { readNndPrivateTicketReceiptUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { probeNndPromotedPrivateAttachUnderOwnership } from './nnd-activation-promoted-private-attach.js';
import { promotedAttachEvidenceSha } from './nnd-activation-ticket-evidence.js';
import { readInstallBytes, hash, operationValid } from './nnd-install-storage.js';

const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'Promoted NND attach receipt is unresolved; preserve the barrier and both owners.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const place = (identity, operationId) => ({ directory: join(identity.data_root, 'runtime', 'nnd',
  'install-slots', 'activations', operationId), child: join(identity.data_root, 'runtime', 'nnd',
  'install-slots', 'activations', `${operationId}.child.json`) });
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!identity || !options || !operationValid(options.operationId)
    || !operationValid(options.stageOperationId) || !operationValid(options.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
async function observed(identity, serviceLease, registryLease, options) {
  const path = place(identity, options.operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, path.directory);
  if (![7, 8, 9].includes(journal.length) || journal[6].phase !== 'private_ticket_verified'
    || journal.length >= 8 && journal[7].phase !== 'promoted_attach_verified'
    || journal.length === 9 && journal[8].phase !== 'completed') throw invalid();
  const ticket = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
  if (ticket.state !== 'private_ticket_recorded_unresolved'
    || ticket.receipt_sha256 !== journal[6].receipt_sha256) throw invalid();
  const child = await readInstallBytes(path.child, 2048, true);
  if (!child) throw invalid();
  const evidenceSha = promotedAttachEvidenceSha(identity, options,
    ticket.receipt_sha256, ticket.registration_revision, hash(child));
  if (journal.length >= 8 && journal[7].evidence_sha256 !== evidenceSha) throw invalid();
  return { path, journal, ticket, evidenceSha };
}

/** Crash observer: absence is unknown, presence is historical evidence only. */
export async function readNndPromotedAttachReceiptUnderOwnership(identity, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    signal.throwIfAborted();
    const found = await observed(identity, serviceLease, registryLease, options);
    return found.journal.length >= 8
      ? Object.freeze({ state: 'promoted_attach_recorded_unresolved', operation_id: options.operationId,
        generation: options.generation, receipt_sha256: found.journal[7].receipt_sha256,
        ticket_receipt_sha256: found.ticket.receipt_sha256 })
      : Object.freeze({ state: 'unknown', operation_id: options.operationId });
  }), { timeoutMs: 300000 });
}

/** Writes only after a fresh one-use private attach; it never retires a barrier. */
export async function recordNndPromotedAttachUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  if (state?.identity !== identity || state.lease !== serviceLease
    || state.record?.instance_id !== options.generation) throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(30000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      const before = await observed(identity, serviceLease, registryLease, options);
      if (before.journal.length !== 7) throw invalid();
      const attached = await probeNndPromotedPrivateAttachUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      if (attached.state !== 'promoted_private_attach_verified_unresolved'
        || attached.operation_id !== options.operationId || attached.generation !== options.generation
        || attached.registration_revision !== before.ticket.registration_revision
        || attached.ticket_receipt_sha256 !== before.ticket.receipt_sha256) throw invalid();
      const after = await observed(identity, serviceLease, registryLease, options);
      if (after.journal.length !== 7 || after.ticket.receipt_sha256 !== before.ticket.receipt_sha256
        || after.evidenceSha !== before.evidenceSha) throw invalid();
      signal.throwIfAborted();
      const row = await appendNndActivationPhase({ ...identity, operation_id: options.operationId },
        before.path.directory, serviceLease, registryLease, 'promoted_attach_verified', before.evidenceSha);
      const reopened = await observed(identity, serviceLease, registryLease, options);
      if (reopened.journal.length !== 8 || reopened.journal[7].receipt_sha256 !== row.receipt_sha256) throw invalid();
      // The append may complete after the caller's window is cancelled. Keep its
      // historical receipt, but never report a successful live continuation.
      signal.throwIfAborted();
      return Object.freeze({ state: 'promoted_attach_recorded_unresolved', operation_id: options.operationId,
        generation: options.generation, receipt_sha256: row.receipt_sha256,
        ticket_receipt_sha256: before.ticket.receipt_sha256 });
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
