// SPDX-License-Identifier: Apache-2.0
/** Durable, unresolved record of the held owner's private UI ticket proof. */
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { probeNndPrivateTicketUnderOwnership } from './nnd-activation-private-ticket.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';
import { privateTicketEvidenceSha, promotedAttachEvidenceSha } from './nnd-activation-ticket-evidence.js';
import { readNndSelectedActivationCandidate } from './nnd-activation-candidate.js';
import { readInstallBytes, hash, json, operationValid } from './nnd-install-storage.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { readLockedManifestOperation, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { readNndPrivateDiscoveryGeneration, readNndServiceDiscovery } from './nnd-service-discovery.js';
import { exactRecord } from './nnd-service-contract.js';
import { validIdentity } from './reliability/process-identity.js';

const invalid = () => new ContractError('nnd_activation_health_invalid',
  'Private NND ticket receipt is unresolved; preserve the pending barrier and both owners.');
const unknown = operationId => Object.freeze({ state: 'unknown', operation_id: operationId });
const ticketPhase = journal => [7, 8, 9].includes(journal.length) && journal[5].phase === 'discovery_published'
  && journal[6].phase === 'private_ticket_verified'
  && (journal.length === 7 || journal[7].phase === 'promoted_attach_verified')
  && (journal.length < 9 || journal[8].phase === 'completed');
function assertPromotedEvidence(journal, identity, options, revision, childSha) {
  if (journal.length >= 8 && journal[7].evidence_sha256 !== promotedAttachEvidenceSha(identity,
    options, journal[6].receipt_sha256, revision, childSha)) throw invalid();
}
const recordedReceipt = (options, journal, registrationRevision) => Object.freeze({ state: 'private_ticket_recorded_unresolved',
  operation_id: options.operationId, generation: options.generation, receipt_sha256: journal[6].receipt_sha256,
  publication_sha256: journal[5].receipt_sha256, registration_revision: registrationRevision });
const CHILD_KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
const IDENTITY_KEYS = ['version', 'pid', 'platform', 'start_id'];
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function location(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  return { directory: join(root, operationId), candidate: join(root, `${operationId}.candidate.json`),
    before: join(root, `${operationId}.registration.before`), child: join(root, `${operationId}.child.json`),
    marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
function assertLocks(identity, serviceLease, registryLease) {
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function assertOwner(identity, state, serviceLease, registryLease, options) {
  if (!identity || !state || !options || !operationValid(options.operationId)
    || !operationValid(options?.stageOperationId) || !operationValid(options?.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))
    || state.identity !== identity || state.lease !== serviceLease || state.record?.instance_id !== options.generation) throw invalid();
  assertLocks(identity, serviceLease, registryLease);
}

/** Crash observer. This is receipt evidence only, never a live or completed service classification. */
export async function readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options = {}) {
  if (!identity || !options || !operationValid(options.operationId) || !operationValid(options.stageOperationId)
    || !operationValid(options.generation)) throw invalid();
  assertLocks(identity, serviceLease, registryLease);
  const place = location(identity, options.operationId);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    signal.throwIfAborted();
    const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, place.directory);
    if (!ticketPhase(journal)) return unknown(options.operationId);
    const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
      installation_id: identity.installation_id, data_id: identity.data_id,
      prepared_sha256: journal[0].receipt_sha256 });
    if (!(await readInstallBytes(place.marker, 1024, true))?.equals(marker)) throw invalid();
    const before = await readInstallBytes(place.before, 16384, true);
    const beforeRevision = before === null ? 'absent' : hash(before);
    const candidate = await readNndSelectedActivationCandidate(identity, serviceLease, registryLease,
      options.stageOperationId, marker, beforeRevision);
    if (journal[0].evidence_sha256 !== candidate.evidence_sha256
      || !(await readInstallBytes(place.candidate, 4096, true))?.equals(json(candidate.evidence))) throw invalid();
    const childBytes = await readInstallBytes(place.child, 2048, true);
    let child;
    try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(childBytes)); }
    catch { throw invalid(); }
    if (!childBytes || !exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, IDENTITY_KEYS)
      || !validIdentity(child.process_identity) || child.process_identity.platform !== 'win32'
      || !/^\d{1,32}$/u.test(child.process_identity.start_id)
      || !childBytes.equals(json(child)) || child.protocol !== '1.0' || child.operation_id !== options.operationId
      || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
      || child.generation !== options.generation || child.version !== candidate.package.version) throw invalid();
    const childSha = hash(childBytes), desired = serializeManifestBytes({ root: candidate.package.root,
      version: candidate.package.version, protocol: candidate.package.protocol });
    const desiredRevision = hash(desired);
    const forward = await readLockedManifestOperation(registryLease, `nnd-activate-${options.operationId}`);
    const current = await readLockedManifestSnapshot(registryLease);
    const pointer = await readNndServiceDiscovery(identity);
    const privateRecord = await readNndPrivateDiscoveryGeneration(identity, serviceLease, options.generation);
    if (forward?.persistence !== 'saved' || forward.operationId !== `nnd-activate-${options.operationId}`
      || forward.beforeRevision !== beforeRevision || forward.persistedRevision !== desiredRevision
      || candidate.evidence.desired_registration_sha256 !== desiredRevision
      || !current.rawBytes?.equals(desired) || current.revision !== desiredRevision
      || !isDeepStrictEqual(pointer, privateRecord)
      || pointer?.installation_id !== identity.installation_id || pointer.data_id !== identity.data_id
      || pointer.instance_id !== options.generation) return unknown(options.operationId);
    if (journal[1].evidence_sha256 !== hash(json({ operation_id: options.operationId,
      stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
      data_id: identity.data_id, version: child.version, payload_sha256: candidate.evidence.payload_sha256 }))
      || journal[2].evidence_sha256 !== hash(json({ installation_id: identity.installation_id,
        data_id: identity.data_id, generation: child.generation, version: child.version }))
      || journal[4].evidence_sha256 !== hash(json({ operation_id: options.operationId,
        before_revision: beforeRevision, after_revision: desiredRevision, child_sha256: childSha }))) throw invalid();
    if (journal[5].evidence_sha256 !== hash(json({ operation_id: options.operationId,
      registration_revision: desiredRevision, child_sha256: childSha,
      generation: options.generation, discovery_sha256: hash(json(privateRecord)) }))) throw invalid();
    if (journal[6].evidence_sha256 !== privateTicketEvidenceSha(identity, options,
      journal[5].receipt_sha256, desiredRevision, childSha)) throw invalid();
    assertPromotedEvidence(journal, identity, options, desiredRevision, childSha);
    signal.throwIfAborted();
    return recordedReceipt(options, journal, desiredRevision);
  }), { timeoutMs: 300000 });
}
function sameProof(left, right) {
  return left.operation_id === right.operation_id && left.generation === right.generation
    && left.registration_revision === right.registration_revision && left.journal_sha256 === right.journal_sha256;
}

export async function recordNndPrivateTicketUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, state, serviceLease, registryLease, options);
  const place = location(identity, options.operationId);
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      const initial = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, place.directory);
      if (initial.length !== 6 || initial[5].phase !== 'discovery_published') throw invalid();
      const proof = await probeNndPrivateTicketUnderOwnership(identity, state, serviceLease, registryLease,
        { ...options, signal });
      const health = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      if (!sameProof(proof, health) || proof.journal_sha256 !== initial[5].receipt_sha256) throw invalid();
      const child = await readInstallBytes(place.child, 2048, true);
      if (!child) throw invalid();
      const current = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, place.directory);
      if (current.length !== 6 || current[5].receipt_sha256 !== initial[5].receipt_sha256) throw invalid();
      const receipt = await appendNndActivationPhase({ ...identity, operation_id: options.operationId },
        place.directory, serviceLease, registryLease, 'private_ticket_verified',
        privateTicketEvidenceSha(identity, options, proof.journal_sha256, proof.registration_revision, hash(child)));
      const after = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal });
      if (!sameProof(proof, after)) throw invalid();
      return Object.freeze({ state: 'private_ticket_recorded_unresolved', operation_id: options.operationId,
        generation: options.generation, publication_sha256: proof.journal_sha256,
        receipt_sha256: receipt.receipt_sha256 });
    } catch { throw invalid(); }
  }), { timeoutMs: 600000 });
}
