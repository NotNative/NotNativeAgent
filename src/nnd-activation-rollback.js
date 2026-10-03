// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestOperation, readLockedManifestSnapshot, transactLockedManifestBytes } from './persistence/manifest-transaction.js';
import { readNndSelectedActivationCandidate } from './nnd-activation-candidate.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { consumeNndStoppedTrialProof } from './nnd-activation-trial.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { readInstallBytes, hash, json, operationValid } from './nnd-install-storage.js';
import { exactRecord } from './nnd-service-contract.js';

const invalid = () => new ContractError('nnd_activation_rollback_invalid',
  'NND registration rollback is unresolved; preserve the pending barrier and evidence.');
const CHILD_KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
const IDENTITY_KEYS = ['version', 'pid', 'platform', 'start_id'];
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function paths(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd');
  const activation = join(root, 'install-slots', 'activations');
  return { directory: join(activation, operationId), candidate: join(activation, `${operationId}.candidate.json`),
    before: join(activation, `${operationId}.registration.before`), child: join(activation, `${operationId}.child.json`),
    marker: join(root, 'installation-pending.json') };
}
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!operationValid(options?.operationId) || !operationValid(options?.stageOperationId)
    || !operationValid(options?.generation)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function parseChild(bytes) {
  if (!bytes) throw invalid();
  let child;
  try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, IDENTITY_KEYS)
    || !json(child).equals(bytes)) throw invalid();
  return child;
}
async function verifiedEvidence(identity, serviceLease, registryLease, evidence, location, options) {
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, location.directory);
  if (![4, 5].includes(journal.length) || journal[3].phase !== 'trial_healthy'
    || journal.length === 5 && journal[4].phase !== 'registration_cas') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!(await readInstallBytes(location.marker, 1024, true))?.equals(marker)) throw invalid();
  const before = await readInstallBytes(location.before, 16384, true);
  const beforeRevision = before === null ? 'absent' : hash(before);
  const candidate = await readNndSelectedActivationCandidate(identity, serviceLease, registryLease,
    options.stageOperationId, marker, beforeRevision);
  if (journal[0].evidence_sha256 !== candidate.evidence_sha256
    || !(await readInstallBytes(location.candidate, 4096, true))?.equals(json(candidate.evidence))) throw invalid();
  const childBytes = await readInstallBytes(location.child, 2048, true);
  const child = parseChild(childBytes), processIdentity = child.process_identity;
  if (child.protocol !== '1.0' || child.operation_id !== options.operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || child.generation !== options.generation || child.version !== candidate.package.version
    || processIdentity.version !== 1 || processIdentity.platform !== 'win32'
    || processIdentity.pid !== evidence.child_identity.pid
    || processIdentity.start_id !== evidence.child_identity.start_id
    || !/^\d{1,32}$/u.test(processIdentity.start_id)
    || hash(childBytes) !== evidence.child_identity.sha256
    || journal[2].evidence_sha256 !== hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation: options.generation, version: child.version }))) throw invalid();
  const desiredRevision = candidate.evidence.desired_registration_sha256;
  const forward = await readLockedManifestOperation(registryLease, `nnd-activate-${options.operationId}`);
  if (!forward || forward.persistence !== 'saved' || forward.beforeRevision !== beforeRevision
    || forward.persistedRevision !== desiredRevision) throw invalid();
  if (journal.length === 5 && journal[4].evidence_sha256 !== hash(json({ operation_id: options.operationId,
    before_revision: beforeRevision, after_revision: desiredRevision, child_sha256: hash(childBytes) }))) throw invalid();
  const current = await readLockedManifestSnapshot(registryLease);
  if (current.revision !== desiredRevision || hash(current.rawBytes ?? Buffer.alloc(0)) !== desiredRevision) throw invalid();
  if (await readNndServiceDiscovery(identity) !== null) throw invalid();
  return { before, beforeRevision, desiredRevision, childSha: hash(childBytes), forward,
    journalSha: journal.at(-1).receipt_sha256 };
}
async function rollbackOwned(identity, serviceLease, registryLease, proof, options, signal) {
  signal.throwIfAborted();
  const location = paths(identity, options.operationId);
  const verified = await verifiedEvidence(identity, serviceLease, registryLease, proof, location, options);
  signal.throwIfAborted();
  const intent = hash(json({ operation_id: options.operationId, stage_operation_id: options.stageOperationId,
    generation: options.generation, before_revision: verified.beforeRevision,
    selected_revision: verified.desiredRevision, child_sha256: verified.childSha,
    forward_receipt_revision: verified.forward.persistedRevision, journal_sha256: verified.journalSha }));
  const pending = await appendNndActivationPhase({ ...identity, operation_id: options.operationId }, location.directory,
    serviceLease, registryLease, 'rollback_pending', intent);
  signal.throwIfAborted();
  // This is a distinct receipt identity from the forward CAS. A death or uncertain
  // publication after this point leaves rollback_pending and the admission barrier.
  const outcome = await transactLockedManifestBytes(registryLease, {
    expectedRevision: verified.desiredRevision, operationId: `nnd-rollback-${options.operationId}`,
    bytes: verified.before, signal,
    payload: { action: 'rollback-nnd-slot', operation_id: options.operationId,
      stage_operation_id: options.stageOperationId, generation: options.generation,
      selected_registration_sha256: verified.desiredRevision, prior_registration_revision: verified.beforeRevision,
      child_sha256: verified.childSha, pending_sha256: pending.receipt_sha256 } });
  if (outcome.persistence !== 'saved' || outcome.beforeRevision !== verified.desiredRevision
    || outcome.persistedRevision !== verified.beforeRevision) throw invalid();
  const receipt = await readLockedManifestOperation(registryLease, `nnd-rollback-${options.operationId}`);
  const current = await readLockedManifestSnapshot(registryLease);
  if (receipt?.persistence !== 'saved' || receipt.beforeRevision !== verified.desiredRevision
    || receipt.persistedRevision !== verified.beforeRevision
    || current.revision !== verified.beforeRevision
    || (verified.before === null ? current.rawBytes !== null : !current.rawBytes?.equals(verified.before))
    || await readNndServiceDiscovery(identity) !== null) throw invalid();
  signal.throwIfAborted();
  const complete = await appendNndActivationPhase({ ...identity, operation_id: options.operationId }, location.directory,
    serviceLease, registryLease, 'rollback_complete', hash(json({ operation_id: options.operationId,
      pending_sha256: pending.receipt_sha256, selected_revision: verified.desiredRevision,
      restored_revision: verified.beforeRevision, rollback_receipt_revision: receipt.persistedRevision })));
  return Object.freeze({ state: 'registration_rolled_back_barrier_held', operation_id: options.operationId,
    registration_revision: verified.beforeRevision, journal_sha256: complete.receipt_sha256 });
}

// Private post-stop continuation only. The one-use proof is minted after owned
// trial.stop() succeeds; this function never clears the admission barrier.
export async function rollbackNndTrialRegistrationAfterStop(identity, serviceLease, registryLease, shutdownProof, options = {}) {
  assertOwner(identity, serviceLease, registryLease, options);
  const evidence = consumeNndStoppedTrialProof(shutdownProof, identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id,
    () => runManifestLeaseWork(registryLease,
      () => rollbackOwned(identity, serviceLease, registryLease, evidence, options, evidence.signal)),
    { timeoutMs: 300000 });
}
