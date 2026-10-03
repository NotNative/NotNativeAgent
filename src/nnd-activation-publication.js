// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { readNndActivationJournal, appendNndActivationPhase } from './nnd-activation-journal.js';
import { reconcileNndRegistrationUnderOwnership } from './nnd-activation-reconciliation.js';
import { readInstallBytes, json, hash, operationValid } from './nnd-install-storage.js';
import { readNndPrivateDiscoveryGeneration, readNndServiceDiscovery, publishNndDiscoveryGeneration } from './nnd-service-discovery.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { validIdentity } from './reliability/process-identity.js';
import { exactRecord } from './nnd-service-contract.js';

const invalid = () => new ContractError('nnd_activation_publication_invalid',
  'NND discovery publication is unresolved; preserve the admission barrier and both owners.');
const CHILD_KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
const IDENTITY_KEYS = ['version', 'pid', 'platform', 'start_id'];
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function location(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  return { directory: join(root, operationId), candidate: join(root, `${operationId}.candidate.json`),
    child: join(root, `${operationId}.child.json`), marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!operationValid(options?.operationId) || !operationValid(options?.stageOperationId)
    || !operationValid(options?.generation)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function liveState(state, options) {
  if (!state?.registrationSelected || state.published || state.stopping || state.child?.failed
    || !state.child?.child || state.child.child.exitCode !== null || !Number.isSafeInteger(state.child.child.pid)
    || state.child.child.pid < 1 || state.record?.instance_id !== options.generation
    || state.package?.version === undefined || state.controller?.endpoint !== state.record.endpoint
    || typeof state.record.control_token !== 'string' || !state.ui) throw invalid();
}
function parseExact(bytes) {
  if (!bytes) throw invalid();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value).equals(bytes)) throw invalid();
  return value;
}
async function selectedEvidence(identity, state, registryLease, options, signal) {
  const place = location(identity, options.operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, place.directory);
  if (journal.length !== 5 || journal[4].phase !== 'registration_cas') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!(await readInstallBytes(place.marker, 1024, true))?.equals(marker)) throw invalid();
  const candidate = parseExact(await readInstallBytes(place.candidate, 4096, true));
  if (candidate.stage_operation_id !== options.stageOperationId || candidate.installation_id !== identity.installation_id
    || candidate.data_id !== identity.data_id || candidate.version !== state.package.version
    || hash(json(candidate)) !== journal[0].evidence_sha256) throw invalid();
  const childBytes = await readInstallBytes(place.child, 2048, true), child = parseExact(childBytes);
  if (!exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, IDENTITY_KEYS)
    || child.protocol !== '1.0' || child.operation_id !== options.operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || child.generation !== options.generation || child.version !== state.package.version
    || !validIdentity(child.process_identity) || child.process_identity.platform !== 'win32'
    || child.process_identity.pid !== state.child.child.pid) throw invalid();
  const desired = serializeManifestBytes({ root: state.package.root, version: state.package.version, protocol: state.package.protocol });
  if (hash(desired) !== candidate.desired_registration_sha256
    || !(await readLockedManifestSnapshot(registryLease)).rawBytes?.equals(desired)) throw invalid();
  if (journal[1].evidence_sha256 !== hash(json({ operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
    data_id: identity.data_id, version: child.version, payload_sha256: candidate.payload_sha256 }))
    || journal[2].evidence_sha256 !== hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation: child.generation, version: child.version }))
    || journal[4].evidence_sha256 !== hash(json({ operation_id: options.operationId,
      before_revision: candidate.registry_before_revision, after_revision: hash(desired), child_sha256: hash(childBytes) }))) throw invalid();
  signal.throwIfAborted();
  return { place, child, childSha: hash(childBytes), registrationRevision: hash(desired) };
}
async function checkProcesses(state, child, signal) {
  liveState(state, { generation: child.generation });
  let observed, parent;
  try {
    observed = await captureDiscoveryProcessIdentity(signal, child.process_identity.pid);
    parent = await captureDiscoveryProcessIdentity(signal);
  } catch { throw invalid(); }
  if (!isDeepStrictEqual(observed, child.process_identity)
    || !isDeepStrictEqual(parent, state.record.process_identity)) throw invalid();
}
async function publishSelected(identity, state, serviceLease, registryLease, options, signal) {
  signal.throwIfAborted(); liveState(state, options);
  const evidence = await selectedEvidence(identity, state, registryLease, options, signal);
  const privateRecord = await readNndPrivateDiscoveryGeneration(identity, serviceLease, options.generation);
  if (!isDeepStrictEqual(privateRecord, state.record) || await readNndServiceDiscovery(identity) !== null) throw invalid();
  await checkProcesses(state, evidence.child, signal);
  signal.throwIfAborted();
  // A thrown publication may have committed current.json. Read it back before
  // deciding whether to journal the exact selected pointer.
  try { await publishNndDiscoveryGeneration(identity, serviceLease, options.generation, null); }
  catch { /* Reconcile the pointer under the still-held ownership below. */ }
  const pointer = await readNndServiceDiscovery(identity);
  if (!isDeepStrictEqual(pointer, privateRecord)) throw invalid();
  await checkProcesses(state, evidence.child, signal);
  signal.throwIfAborted();
  const receipt = await appendNndActivationPhase({ ...identity, operation_id: options.operationId }, evidence.place.directory,
    serviceLease, registryLease, 'discovery_published', hash(json({ operation_id: options.operationId,
      registration_revision: evidence.registrationRevision, child_sha256: evidence.childSha,
      generation: options.generation, discovery_sha256: hash(json(privateRecord)) })));
  return Object.freeze({ state: 'discovery_published_unresolved', operation_id: options.operationId,
    generation: options.generation, registration_revision: evidence.registrationRevision,
    journal_sha256: receipt.receipt_sha256 });
}

// Internal held-live primitive only. The trial's current lifecycle always stops
// its child; callers must not wire this into that continuation until durable
// completion, same-process principal promotion, and live owner transfer exist.
export async function publishNndSelectedDiscoveryUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  liveState(state, options);
  const selected = await reconcileNndRegistrationUnderOwnership(identity, serviceLease, registryLease,
    { operationId: options.operationId });
  if (selected.state !== 'selected_unresolved' || selected.child_state !== 'same_process') throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease,
      () => publishSelected(identity, state, serviceLease, registryLease, options, signal)), { timeoutMs: 300000 });
}
