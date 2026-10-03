// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestOperation, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { loadInstallTransaction } from './nnd-install-transaction.js';
import { readNndActivationJournal } from './nnd-activation-journal.js';
import { readInstallBytes, json, hash, operationValid } from './nnd-install-storage.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { validIdentity } from './reliability/process-identity.js';
import { exactRecord } from './nnd-service-contract.js';

const invalid = () => new ContractError('nnd_activation_reconciliation_invalid',
  'NND activation outcome is unresolved; preserve the pending barrier and evidence.');
const unknown = operationId => Object.freeze({ state: 'unknown', operation_id: operationId });
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const CANDIDATE_KEYS = ['protocol', 'stage_operation_id', 'installation_id', 'data_id', 'version',
  'payload_sha256', 'stage_prepared_sha256', 'stage_ready_sha256', 'provenance_sha256', 'slot_ino',
  'slot_dev', 'registry_before_revision', 'desired_registration_sha256'];
const CHILD_KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
const IDENTITY_KEYS = ['version', 'pid', 'platform', 'start_id'];
const SHA = /^[a-f0-9]{64}$/u;
function locations(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots');
  const activation = join(root, 'activations');
  return { root, directory: join(activation, operationId), candidate: join(activation, `${operationId}.candidate.json`),
    before: join(activation, `${operationId}.registration.before`), child: join(activation, `${operationId}.child.json`),
    marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
function owner(identity, serviceLease, registryLease, operationId) {
  if (!operationValid(operationId)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function parseExact(bytes, keys) {
  if (!bytes) throw invalid();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactRecord(value, keys) || !json(value).equals(bytes)) throw invalid();
  return value;
}
async function prepared(identity, operationId, location) {
  const journal = await readNndActivationJournal({ ...identity, operation_id: operationId }, location.directory);
  if (![4, 5].includes(journal.length) || journal[3].phase !== 'trial_healthy'
    || journal.length === 5 && journal[4].phase !== 'registration_cas') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!(await readInstallBytes(location.marker, 1024, true))?.equals(marker)) throw invalid();
  const candidateBytes = await readInstallBytes(location.candidate, 4096, true);
  const candidate = parseExact(candidateBytes, CANDIDATE_KEYS);
  if (hash(candidateBytes) !== journal[0].evidence_sha256 || candidate.protocol !== '2.0'
    || candidate.installation_id !== identity.installation_id || candidate.data_id !== identity.data_id
    || !operationValid(candidate.stage_operation_id) || !SHA.test(candidate.payload_sha256)
    || !SHA.test(candidate.stage_prepared_sha256) || !SHA.test(candidate.stage_ready_sha256)
    || !SHA.test(candidate.provenance_sha256) || !SHA.test(candidate.desired_registration_sha256)) throw invalid();
  const before = await readInstallBytes(location.before, 16384, true);
  const beforeRevision = before === null ? 'absent' : hash(before);
  if (candidate.registry_before_revision !== beforeRevision) throw invalid();
  const store = { transactions: join(location.root, 'transactions'), versions: join(location.root, 'versions') };
  const transaction = await loadInstallTransaction(identity, store, candidate.stage_operation_id);
  if (transaction.record.version !== candidate.version || transaction.record.payload_sha256 !== candidate.payload_sha256
    || hash(transaction.bytes) !== candidate.stage_prepared_sha256) throw invalid();
  const desired = serializeManifestBytes({ root: transaction.slot, version: candidate.version, protocol: '1.0' });
  if (hash(desired) !== candidate.desired_registration_sha256) throw invalid();
  return { journal, candidate, before, beforeRevision, desired };
}
async function childEvidence(identity, operationId, location, preparedState) {
  const bytes = await readInstallBytes(location.child, 2048, true);
  if (!bytes) return null;
  const child = parseExact(bytes, CHILD_KEYS);
  const processIdentity = child.process_identity;
  if (child.protocol !== '1.0' || child.operation_id !== operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || !operationValid(child.generation) || child.version !== preparedState.candidate.version
    || !exactRecord(processIdentity, IDENTITY_KEYS) || !validIdentity(processIdentity)
    || processIdentity.platform !== 'win32' || !/^\d{1,32}$/u.test(processIdentity.start_id)) throw invalid();
  const running = json({ installation_id: identity.installation_id, data_id: identity.data_id,
    generation: child.generation, version: child.version });
  if (preparedState.journal[2].evidence_sha256 !== hash(running)) throw invalid();
  return { bytes, processIdentity, generation: child.generation };
}
async function childState(child, signal) {
  if (!child) return 'not_recorded';
  try {
    const observed = await captureDiscoveryProcessIdentity(signal, child.processIdentity.pid);
    if (!validIdentity(observed) || observed.platform !== 'win32'
      || observed.pid !== child.processIdentity.pid) return 'unconfirmed';
    return observed.start_id === child.processIdentity.start_id ? 'same_process' : 'different_process';
  } catch { return 'unconfirmed'; }
}
async function classify(identity, registryLease, operationId, location, signal) {
  const evidence = await prepared(identity, operationId, location);
  const child = await childEvidence(identity, operationId, location, evidence);
  const pointer = await readNndServiceDiscovery(identity);
  // Preparation captured no predecessor discovery pointer. Any publication,
  // including a foreign generation, must be resolved before classification.
  if (pointer !== null) return unknown(operationId);
  const observedChild = await childState(child, signal);
  if (child && observedChild !== 'same_process') return unknown(operationId);
  const current = await readLockedManifestSnapshot(registryLease);
  const receipt = await readLockedManifestOperation(registryLease, `nnd-activate-${operationId}`);
  const beforeMatches = evidence.before === null ? current.rawBytes === null : current.rawBytes?.equals(evidence.before);
  const desiredMatches = current.rawBytes?.equals(evidence.desired) === true;
  const afterRevision = hash(evidence.desired);
  const receiptMatches = receipt && receipt.beforeRevision === evidence.beforeRevision
    && (receipt.persistence !== 'saved' || receipt.persistedRevision === afterRevision);
  if (receipt && !receiptMatches) return unknown(operationId);
  if (evidence.journal.length === 5 && (!child || receipt?.persistence !== 'saved'
    || evidence.journal[4].evidence_sha256 !== hash(json({ operation_id: operationId,
      before_revision: evidence.beforeRevision, after_revision: afterRevision, child_sha256: hash(child.bytes) })))) return unknown(operationId);
  if (receipt?.persistence === 'saved' && desiredMatches && child) return Object.freeze({
    state: 'selected_unresolved', operation_id: operationId, child_state: observedChild });
  // Once child evidence exists, a missing manifest receipt cannot prove that
  // a saved CAS was never later restored to the same prior bytes.
  if ((!receipt && !child && !desiredMatches || receipt?.persistence === 'unpublished')
    && beforeMatches && evidence.journal.length === 4)
    return Object.freeze({ state: 'not_selected', operation_id: operationId,
      child_state: observedChild });
  return unknown(operationId);
}

// This is observation under genuine native locks, not rollback or forward activation.
// Missing/conflicting evidence remains behind the protocol-three admission barrier.
export async function reconcileNndRegistrationUnderOwnership(identity, serviceLease, registryLease, { operationId } = {}) {
  owner(identity, serviceLease, registryLease, operationId);
  const location = locations(identity, operationId);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease, async () => {
      try { return await classify(identity, registryLease, operationId, location, signal); }
      catch { return unknown(operationId); }
    }), { timeoutMs: 300000 });
}
