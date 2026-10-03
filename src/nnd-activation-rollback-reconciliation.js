// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestOperation, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { readNndSelectedActivationCandidate } from './nnd-activation-candidate.js';
import { readNndActivationJournal } from './nnd-activation-journal.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { readInstallBytes, hash, json, operationValid } from './nnd-install-storage.js';
import { exactRecord } from './nnd-service-contract.js';
import { validIdentity } from './reliability/process-identity.js';

const invalid = () => new ContractError('nnd_activation_rollback_invalid',
  'NND registration rollback evidence is unresolved; preserve the pending barrier.');
const unknown = operationId => Object.freeze({ state: 'unknown', operation_id: operationId });
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
function assertOwner(identity, serviceLease, registryLease, operationId) {
  if (!operationValid(operationId)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function childRecord(bytes, identity, operationId, candidate) {
  if (!bytes) throw invalid();
  let child;
  try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, IDENTITY_KEYS)
    || !json(child).equals(bytes) || child.protocol !== '1.0' || child.operation_id !== operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || !operationValid(child.generation) || child.version !== candidate.package.version
    || !validIdentity(child.process_identity) || child.process_identity.platform !== 'win32'
    || !/^\d{1,32}$/u.test(child.process_identity.start_id)) throw invalid();
  return child;
}
async function observe(identity, serviceLease, registryLease, operationId, location, signal) {
  signal.throwIfAborted();
  const journal = await readNndActivationJournal({ ...identity, operation_id: operationId }, location.directory);
  const pendingIndex = journal.findIndex(item => item.phase === 'rollback_pending');
  if ((pendingIndex !== 4 && pendingIndex !== 5) || journal[3]?.phase !== 'trial_healthy'
    || pendingIndex === 5 && journal[4]?.phase !== 'registration_cas'
    || ![pendingIndex + 1, pendingIndex + 2].includes(journal.length)
    || journal.length === pendingIndex + 2 && journal.at(-1).phase !== 'rollback_complete') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!(await readInstallBytes(location.marker, 1024, true))?.equals(marker)) throw invalid();
  const before = await readInstallBytes(location.before, 16384, true);
  const beforeRevision = before === null ? 'absent' : hash(before);
  const candidateBytes = await readInstallBytes(location.candidate, 4096, true);
  if (!candidateBytes || hash(candidateBytes) !== journal[0].evidence_sha256) throw invalid();
  let candidateRecord;
  try { candidateRecord = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)); }
  catch { throw invalid(); }
  if (!operationValid(candidateRecord?.stage_operation_id)) throw invalid();
  const candidate = await readNndSelectedActivationCandidate(identity, serviceLease, registryLease,
    candidateRecord.stage_operation_id, marker, beforeRevision);
  if (!candidateBytes.equals(json(candidate.evidence)) || candidate.evidence_sha256 !== journal[0].evidence_sha256) throw invalid();
  if (journal[1].evidence_sha256 !== hash(json({ operation_id: operationId,
    stage_operation_id: candidateRecord.stage_operation_id,
    installation_id: identity.installation_id, data_id: identity.data_id,
    version: candidate.package.version, payload_sha256: candidate.evidence.payload_sha256 }))) throw invalid();
  const childBytes = await readInstallBytes(location.child, 2048, true);
  const child = childRecord(childBytes, identity, operationId, candidate);
  const childSha = hash(childBytes);
  if (journal[2].evidence_sha256 !== hash(json({ installation_id: identity.installation_id,
    data_id: identity.data_id, generation: child.generation, version: child.version }))) throw invalid();
  const selectedRevision = candidate.evidence.desired_registration_sha256;
  const forward = await readLockedManifestOperation(registryLease, `nnd-activate-${operationId}`);
  if (forward?.operationId !== `nnd-activate-${operationId}` || forward.persistence !== 'saved'
    || forward.beforeRevision !== beforeRevision
    || forward.persistedRevision !== selectedRevision) throw invalid();
  if (pendingIndex === 5 && journal[4].evidence_sha256 !== hash(json({ operation_id: operationId,
    before_revision: beforeRevision, after_revision: selectedRevision, child_sha256: childSha }))) throw invalid();
  const pending = journal[pendingIndex];
  if (pending.evidence_sha256 !== hash(json({ operation_id: operationId,
    stage_operation_id: candidateRecord.stage_operation_id, generation: child.generation,
    before_revision: beforeRevision, selected_revision: selectedRevision, child_sha256: childSha,
    forward_receipt_revision: forward.persistedRevision, journal_sha256: journal[pendingIndex - 1].receipt_sha256 }))) throw invalid();
  // A published controller, even one from another generation, is never
  // evidence of safe rollback. No PID observation can establish shutdown.
  if (await readNndServiceDiscovery(identity) !== null) throw invalid();
  const rollback = await readLockedManifestOperation(registryLease, `nnd-rollback-${operationId}`);
  const current = await readLockedManifestSnapshot(registryLease);
  signal.throwIfAborted();
  return classifyRollback({ rollback, current, before, beforeRevision, selectedRevision,
    journal, pendingIndex, pending, operationId });
}
function classifyRollback({ rollback, current, before, beforeRevision, selectedRevision,
  journal, pendingIndex, pending, operationId }) {
  if (rollback?.operationId !== `nnd-rollback-${operationId}`
    || rollback.beforeRevision !== selectedRevision) throw invalid();
  const restored = current.revision === beforeRevision
    && (before === null ? current.rawBytes === null : current.rawBytes?.equals(before) === true);
  const selected = current.revision === selectedRevision && current.rawBytes !== null
    && hash(current.rawBytes) === selectedRevision;
  const complete = journal.length === pendingIndex + 2;
  if (complete && journal.at(-1).evidence_sha256 !== hash(json({ operation_id: operationId,
    pending_sha256: pending.receipt_sha256, selected_revision: selectedRevision,
    restored_revision: beforeRevision, rollback_receipt_revision: beforeRevision }))) throw invalid();
  if (rollback.persistence === 'saved' && rollback.persistedRevision === beforeRevision && restored)
    return Object.freeze({ state: 'registration_restored_barrier_held', operation_id: operationId });
  if (!complete && rollback.persistence === 'unpublished' && rollback.persistedRevision === null && selected)
    return Object.freeze({ state: 'rollback_not_published_barrier_held', operation_id: operationId });
  return unknown(operationId);
}

// Observation only after acquiring a new genuine owner. It never repeats a
// rollback CAS, edits the journal, clears the barrier, or treats PID absence
// as proof that an abandoned child stopped.
export async function reconcileNndRollbackUnderOwnership(identity, serviceLease, registryLease, { operationId } = {}) {
  assertOwner(identity, serviceLease, registryLease, operationId);
  const location = paths(identity, operationId);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease, async () => {
      try { return await observe(identity, serviceLease, registryLease, operationId, location, signal); }
      catch { return unknown(operationId); }
    }), { timeoutMs: 300000 });
}
