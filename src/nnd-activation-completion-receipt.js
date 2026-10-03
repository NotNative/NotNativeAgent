// SPDX-License-Identifier: Apache-2.0
/** Private terminal decision under the retained owner; admission remains barred. */
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { readNndPromotedAttachReceiptUnderOwnership } from './nnd-activation-promoted-attach-receipt.js';
import { readNndPrivateTicketReceiptUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';
import { completionEvidenceSha } from './nnd-activation-ticket-evidence.js';
import { readInstallBytes, hash, operationValid } from './nnd-install-storage.js';

const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND completion is unresolved; preserve the pending barrier and original owner.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!identity || !options || !operationValid(options.operationId)
    || !operationValid(options.stageOperationId) || !operationValid(options.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
async function observed(identity, serviceLease, registryLease, options) {
  const directory = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations', options.operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, directory);
  if (![8, 9].includes(journal.length) || journal[7].phase !== 'promoted_attach_verified'
    || journal.length === 9 && journal[8].phase !== 'completed') throw invalid();
  const promoted = await readNndPromotedAttachReceiptUnderOwnership(identity, serviceLease, registryLease, options);
  if (promoted.state !== 'promoted_attach_recorded_unresolved'
    || promoted.receipt_sha256 !== journal[7].receipt_sha256) throw invalid();
  const child = await readInstallBytes(join(identity.data_root, 'runtime', 'nnd', 'install-slots',
    'activations', `${options.operationId}.child.json`), 2048, true);
  if (!child) throw invalid();
  const ticket = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
  if (ticket.state !== 'private_ticket_recorded_unresolved'
    || ticket.receipt_sha256 !== promoted.ticket_receipt_sha256) throw invalid();
  // Invariant: the predecessor reader revalidates the marker, selected package,
  // manifest, pointer, child identity and every prior evidence hash under both locks.
  const evidenceSha = completionEvidenceSha(identity, options, promoted.receipt_sha256,
    ticket.registration_revision, hash(child));
  if (journal.length === 9 && journal[8].evidence_sha256 !== evidenceSha) throw invalid();
  return { directory, journal, promoted, evidenceSha, registration: ticket.registration_revision };
}
function assertLiveRetainedOwner(state, options) {
  if (!state?.retained || !state.retainedLeaseArmed || state.stopping || state.published
    || state.child?.failed || !state.child?.child || state.child.child.exitCode !== null
    || !state.controller?.isListening?.() || !state.native?.isListening?.()
    || state.record?.instance_id !== options.generation
    || state.activationOperationId !== options.operationId
    || state.stageOperationId !== options.stageOperationId) throw invalid();
}

/** Crash observer: a receipt proves a decision, never a live service or cleared barrier. */
export async function readNndCompletionReceiptUnderOwnership(identity, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    signal.throwIfAborted();
    const found = await observed(identity, serviceLease, registryLease, options);
    return found.journal.length === 9
      ? Object.freeze({ state: 'completion_recorded_barred', operation_id: options.operationId,
        generation: options.generation, receipt_sha256: found.journal[8].receipt_sha256,
        promoted_receipt_sha256: found.promoted.receipt_sha256 })
      : Object.freeze({ state: 'unknown', operation_id: options.operationId });
  }), { timeoutMs: 300000 });
}

/** Only a live, armed, same-process retained owner may make this decision once. */
export async function recordNndCompletionUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  if (state?.identity !== identity || state.lease !== serviceLease) throw invalid();
  assertLiveRetainedOwner(state, options);
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(30000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      const before = await observed(identity, serviceLease, registryLease, options);
      if (before.journal.length !== 8 || state.promotedAttachReceipt?.receipt_sha256 !== before.promoted.receipt_sha256) throw invalid();
      const health = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      if (health.registration_revision !== before.registration
        || health.generation !== options.generation) throw invalid();
      const after = await observed(identity, serviceLease, registryLease, options);
      if (after.journal.length !== 8 || after.promoted.receipt_sha256 !== before.promoted.receipt_sha256
        || after.evidenceSha !== before.evidenceSha) throw invalid();
      assertLiveRetainedOwner(state, options);
      signal.throwIfAborted();
      const row = await appendNndActivationPhase({ ...identity, operation_id: options.operationId },
        before.directory, serviceLease, registryLease, 'completed', before.evidenceSha);
      const reopened = await observed(identity, serviceLease, registryLease, options);
      if (reopened.journal.length !== 9 || reopened.journal[8].receipt_sha256 !== row.receipt_sha256) throw invalid();
      signal.throwIfAborted();
      return Object.freeze({ state: 'completion_recorded_barred', operation_id: options.operationId,
        generation: options.generation, receipt_sha256: row.receipt_sha256,
        promoted_receipt_sha256: before.promoted.receipt_sha256 });
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
