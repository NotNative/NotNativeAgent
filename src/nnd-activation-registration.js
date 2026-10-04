// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestSnapshot, transactLockedManifest } from './persistence/manifest-transaction.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { readNndPreparedActivationCandidate } from './nnd-activation-candidate.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { readInstallBytes, writeInstallNew, json, hash, operationValid } from './nnd-install-storage.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { validIdentity } from './reliability/process-identity.js';

const invalid = () => new ContractError('nnd_activation_registration_invalid',
  'NND registration selection is unresolved; preserve the pending barrier and exact prior bytes.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function locations(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  return { directory: join(root, operationId), candidate: join(root, `${operationId}.candidate.json`),
    before: join(root, `${operationId}.registration.before`), child: join(root, `${operationId}.child.json`),
    marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
function assertOwner(identity, serviceLease, registryLease, operationId, stageOperationId) {
  if (!operationValid(operationId) || !operationValid(stageOperationId)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
async function preparedEvidence(identity, serviceLease, registryLease, operationId, stageOperationId) {
  const location = locations(identity, operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: operationId }, location.directory);
  if (journal.length !== 4 || journal.at(-1).phase !== 'trial_healthy') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  const actualMarker = await readInstallBytes(location.marker, 1024, true);
  if (!actualMarker?.equals(marker)) throw invalid();
  const candidate = await readNndPreparedActivationCandidate(identity, serviceLease, registryLease, stageOperationId, marker);
  if (journal[0].evidence_sha256 !== candidate.evidence_sha256
    || !(await readInstallBytes(location.candidate, 4096))?.equals(json(candidate.evidence))) throw invalid();
  const before = await readInstallBytes(location.before, 16384, true);
  if (candidate.evidence.registry_before_revision !== (before === null ? 'absent' : hash(before))) throw invalid();
  const snapshot = await readLockedManifestSnapshot(registryLease);
  if (before === null ? snapshot.rawBytes !== null : !snapshot.rawBytes?.equals(before)) throw invalid();
  const record = { root: candidate.package.root, version: candidate.package.version, protocol: candidate.package.protocol };
  if (typeof record.root !== 'string' || !isAbsolute(record.root)
    || typeof record.version !== 'string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(record.version)
    || record.protocol !== '1.0') throw invalid();
  const desired = serializeManifestBytes(record);
  if (candidate.evidence.desired_registration_sha256 !== hash(desired)) throw invalid();
  return { location, candidate, before, record, desired };
}
async function liveChildIdentity(state, signal) {
  const pid = state.child?.child?.pid;
  if (state.stopping || state.child?.failed || !Number.isSafeInteger(pid) || pid < 1
    || state.child.child.exitCode !== null) throw invalid();
  let observed;
  try { observed = await captureDiscoveryProcessIdentity(signal, pid); }
  catch (error) {
    if (error?.code === 'nnd_private_storage_unavailable') throw error;
    throw invalid();
  }
  if (!validIdentity(observed) || observed.platform !== 'win32' || !observed.start_id
    || state.child.failed || state.stopping || state.child.child.exitCode !== null) throw invalid();
  return observed;
}
async function captureLiveProcessIdentity(state, signal) {
  // Why: two 30-second cold Windows helper windows fit inside one acquired
  // registration lease; a cold timeout may be transient, but unusual identity
  // failures must remain unresolved.
  try { return await liveChildIdentity(state, signal); }
  catch (error) {
    if (error?.code !== 'nnd_private_storage_unavailable') throw error;
  }
  return liveChildIdentity(state, signal);
}
async function persistChild(identity, location, operationId, state, processIdentity) {
  const bytes = json({ protocol: '1.0', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    generation: state.record.instance_id, version: state.package.version, process_identity: processIdentity });
  if (bytes.length > 2048) throw invalid();
  const existing = await readInstallBytes(location.child, 2048, true);
  if (existing) { if (!existing.equals(bytes)) throw invalid(); return hash(bytes); }
  try { await writeInstallNew(location.child, bytes); }
  catch { throw invalid(); }
  if (!(await readInstallBytes(location.child, 2048))?.equals(bytes)) throw invalid();
  return hash(bytes);
}
async function selectUnderOwnership(identity, state, serviceLease, registryLease, options, signal) {
  const { operationId, stageOperationId } = options;
  signal.throwIfAborted();
  const prepared = await preparedEvidence(identity, serviceLease, registryLease, operationId, stageOperationId);
  if (state.record.instance_id !== options.generation || state.package.version !== prepared.candidate.package.version) throw invalid();
  if (state.record.instance_id !== options.generation || state.package.version !== prepared.candidate.package.version) throw invalid();
  const processIdentity = await captureLiveProcessIdentity(state, signal);
  const childSha = await persistChild(identity, prepared.location, operationId, state, processIdentity);
  signal.throwIfAborted();
  if ((await liveChildIdentity(state, signal)).start_id !== processIdentity.start_id) throw invalid();
  const outcome = await transactLockedManifest(registryLease, { expectedRevision: prepared.candidate.evidence.registry_before_revision,
    operationId: `nnd-activate-${operationId}`, signal,
    payload: { action: 'activate-nnd-slot', operation_id: operationId, stage_operation_id: stageOperationId,
      desired_registration_sha256: hash(prepared.desired) },
    transform: () => prepared.record,
    validate: value => { if (JSON.stringify(value) !== JSON.stringify(prepared.record)) throw invalid(); } });
  if (outcome.persistence !== 'saved' || outcome.persistedRevision !== hash(prepared.desired)
    || !(await readLockedManifestSnapshot(registryLease)).rawBytes?.equals(prepared.desired)) throw invalid();
  if ((await liveChildIdentity(state, signal)).start_id !== processIdentity.start_id) throw invalid();
  const receipt = await appendNndActivationPhase({ ...identity, operation_id: operationId }, prepared.location.directory,
    serviceLease, registryLease, 'registration_cas', hash(json({ operation_id: operationId,
      before_revision: outcome.beforeRevision, after_revision: outcome.persistedRevision, child_sha256: childSha })));
  return Object.freeze({ state: 'registration_selected_unresolved', operation_id: operationId,
    registration_revision: outcome.persistedRevision, child_sha256: childSha, journal_sha256: receipt.receipt_sha256 });
}

// Internal held-live continuation only. This does not publish discovery or
// clear the activation barrier; any failure after CAS remains unresolved.
export async function selectNndTrialRegistrationUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options.operationId, options.stageOperationId);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease,
      () => selectUnderOwnership(identity, state, serviceLease, registryLease, options, signal)),
    { timeoutMs: 300000 });
}
