// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { openInstallStore, readInstallBytes, json, hash, operationValid } from './nnd-install-storage.js';
import { loadInstallTransaction, installHost } from './nnd-install-transaction.js';
import { readSlotProvenance, slotOwner } from './nnd-install-storage-provenance.js';
import { assertNndInstallRuntimePaths } from './nnd-install-storage-paths.js';
import { verifyNndPayload, readPayloadBytes } from './nnd-payload-contract.js';
import { validateNndPackage } from './nnd-package.js';
import { readNndActivationJournal } from './nnd-activation-journal.js';
import { hasActivationInitialization } from './nnd-activation-initialization-db.js';

const CAPS = new WeakMap();
const ISSUED = new WeakMap();
const invalid = () => new ContractError('nnd_activation_candidate_invalid',
  'The staged NND package or activation preparation could not be verified; keep the admission barrier.');
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

function assertOwner(identity, serviceLease, registryLease) {
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function requireReady(ready, transaction) {
  const expected = json({ protocol: '2.0', operation_id: transaction.record.operation_id,
    prepared_sha256: hash(transaction.bytes), state: 'slot_ready' });
  if (!ready?.equals(expected)) throw invalid();
}
async function verifiedCandidate(identity, store, stageOperationId, registryLease, signal, expectedRevision) {
  const transaction = await loadInstallTransaction(identity, store, stageOperationId);
  const ready = await readInstallBytes(join(transaction.directory, 'ready.json'), 1024, true);
  requireReady(ready, transaction);
  const proof = await readSlotProvenance(identity, store, transaction.record.payload_sha256);
  if (!proof || proof.value.version !== transaction.record.version) throw invalid();
  const owner = await slotOwner(transaction.slot);
  if (owner.ino !== proof.value.ino || owner.dev !== proof.value.dev) throw invalid();
  if (transaction.record.reused_provenance === null
    ? proof.value.publication_id !== stageOperationId
    : hash(proof.bytes) !== transaction.record.reused_provenance) throw invalid();
  const verified = await verifyNndPayload(transaction.slot, { signal, host: installHost(identity) });
  assertNndInstallRuntimePaths(transaction.slot, verified.manifest);
  if (verified.sha256 !== transaction.record.payload_sha256 || verified.manifest.version !== proof.value.version
    || proof.value.bytes !== verified.bytes.length + verified.manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw invalid();
  const info = await validateNndPackage(transaction.slot, { serviceHost: installHost(identity) });
  if (!samePath(info.root, transaction.slot) || info.version !== verified.manifest.version) throw invalid();
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPayloadBytes(info.manifestPath, 16384)));
  const entrypoint = await realpath(join(info.root, manifest.service_activation.entrypoint));
  const expectedEntry = verified.manifest.files.find(file => file.path === manifest.service_activation.entrypoint);
  if (!expectedEntry || !samePath(entrypoint, join(info.root, expectedEntry.path))) throw invalid();
  const snapshot = expectedRevision === undefined ? await readLockedManifestSnapshot(registryLease) : null;
  const desired = serializeManifestBytes({ root: info.root, version: info.version, protocol: info.protocol });
  const evidence = Object.freeze({ protocol: '2.0', stage_operation_id: stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id, version: info.version,
    payload_sha256: verified.sha256, stage_prepared_sha256: hash(transaction.bytes),
    stage_ready_sha256: hash(ready),
    provenance_sha256: hash(proof.bytes), slot_ino: owner.ino, slot_dev: owner.dev,
    registry_before_revision: expectedRevision ?? snapshot.revision, desired_registration_sha256: hash(desired) });
  return { evidence, package: Object.freeze({ ...info, entrypoint }), slot: transaction.slot };
}

// Security: only a genuine owner of the data root and its registration mutex can evaluate a slot.
// The candidate is descriptive; it does not publish registration, discovery or a browser ticket.
async function candidateOwned(identity, serviceLease, registryLease, stageOperationId, expectedMarker, expectedRevision) {
  if (!operationValid(stageOperationId)) throw invalid();
  if (expectedRevision !== undefined && !/^(absent|[a-f0-9]{64})$/u.test(expectedRevision)) throw invalid();
  assertOwner(identity, serviceLease, registryLease);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    const store = await openInstallStore(identity, signal);
    const marker = await readInstallBytes(store.pending, 1024, true);
    if (expectedMarker ? !marker?.equals(expectedMarker) : marker !== null) throw invalid();
    const candidate = await verifiedCandidate(identity, store, stageOperationId, registryLease, signal, expectedRevision);
    return Object.freeze({ ...candidate, evidence_sha256: hash(json(candidate.evidence)) });
  }), { timeoutMs: 300000 });
}
export async function readNndActivationCandidate(identity, serviceLease, registryLease, stageOperationId) {
  return candidateOwned(identity, serviceLease, registryLease, stageOperationId, null);
}
export async function readNndPreparedActivationCandidate(identity, serviceLease, registryLease, stageOperationId, marker) {
  return candidateOwned(identity, serviceLease, registryLease, stageOperationId, marker);
}
// For post-selection verification only: the original revision is supplied from
// private preparation evidence while the currently selected manifest is checked by its caller.
export async function readNndSelectedActivationCandidate(identity, serviceLease, registryLease, stageOperationId, marker, beforeRevision) {
  return candidateOwned(identity, serviceLease, registryLease, stageOperationId, marker, beforeRevision);
}

// Security: a prepared journal receipt and an owned pending barrier are both required before a
// one-use in-process capability can reach the unpublished trial constructor.
export async function issueNndTrialCapability(identity, serviceLease, registryLease, stageOperationId, activationOperationId) {
  if (!operationValid(activationOperationId)) throw invalid();
  assertOwner(identity, serviceLease, registryLease);
  if (await hasActivationInitialization(identity.data_root)) throw invalid();
  const directory = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations', activationOperationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: activationOperationId }, directory);
  if (journal.length !== 1 || journal[0].phase !== 'prepared') throw invalid();
  const expected = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: activationOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: journal[0].receipt_sha256 });
  const candidate = await candidateOwned(identity, serviceLease, registryLease, stageOperationId, expected);
  if (journal[0].evidence_sha256 !== candidate.evidence_sha256) throw invalid();
  const stillPrepared = await readNndActivationJournal({ ...identity, operation_id: activationOperationId }, directory);
  if (stillPrepared.length !== 1 || stillPrepared[0].phase !== 'prepared'
    || stillPrepared[0].receipt_sha256 !== journal[0].receipt_sha256
    || stillPrepared[0].evidence_sha256 !== candidate.evidence_sha256) throw invalid();
  // Invariant: one prepared activation cannot authorize two concurrent unpublished writers
  // through separately minted one-use tokens while the same singleton lease remains held.
  const issued = ISSUED.get(serviceLease) ?? new Set();
  if (issued.has(activationOperationId)) throw invalid();
  issued.add(activationOperationId); ISSUED.set(serviceLease, issued);
  const token = Object.freeze({});
  CAPS.set(token, { identity: identity.installation_id + ':' + identity.data_id, serviceLease, registryLease,
    stageOperationId, activationOperationId, package: candidate.package, used: false });
  return token;
}

export function consumeNndTrialCapability(token, identity, serviceLease, registryLease) {
  const state = CAPS.get(token);
  if (!state || state.used || state.identity !== identity?.installation_id + ':' + identity?.data_id
    || state.serviceLease !== serviceLease || state.registryLease !== registryLease) throw invalid();
  assertOwner(identity, serviceLease, registryLease);
  state.used = true;
  return state.package;
}
