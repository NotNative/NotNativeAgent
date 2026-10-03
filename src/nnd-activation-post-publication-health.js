// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestOperation, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { serializeManifestBytes } from './persistence/manifest-files.js';
import { readNndActivationJournal } from './nnd-activation-journal.js';
import { readNndSelectedActivationCandidate } from './nnd-activation-candidate.js';
import { readInstallBytes, hash, json, operationValid } from './nnd-install-storage.js';
import { readNndPrivateDiscoveryGeneration, readNndServiceDiscovery } from './nnd-service-discovery.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { exactRecord, isNndLoopbackEndpoint } from './nnd-service-contract.js';
import { validIdentity } from './reliability/process-identity.js';
import { issueNndPrincipalTransitionProof } from './nnd-activation-principal-proof.js';

const invalid = () => new ContractError('nnd_activation_health_invalid',
  'Published NND trial health is unresolved; preserve the pending barrier and both owners.');
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
    || state.controller?.endpoint !== state.record.endpoint || state.controller.isListening?.() !== true
    || !isNndLoopbackEndpoint(state.ui) || !isNndLoopbackEndpoint(state.native?.endpoint)
    || state.native.isListening?.() !== true
    || !/^[A-Za-z0-9_-]{43}$/u.test(state.native?.token ?? '')
    || !/^[A-Za-z0-9_-]{43}$/u.test(state.uiHealthKey ?? '')
    || Buffer.from(state.uiHealthKey, 'base64url').toString('base64url') !== state.uiHealthKey) throw invalid();
}
function exactChild(bytes, identity, options, version, pid) {
  if (!bytes) throw invalid();
  let child;
  try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, IDENTITY_KEYS)
    || !json(child).equals(bytes) || child.protocol !== '1.0' || child.operation_id !== options.operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || child.generation !== options.generation || child.version !== version
    || !validIdentity(child.process_identity) || child.process_identity.platform !== 'win32'
    || child.process_identity.pid !== pid || !/^\d{1,32}$/u.test(child.process_identity.start_id)) throw invalid();
  return child;
}
async function selectedEvidence(identity, state, serviceLease, registryLease, options) {
  const place = location(identity, options.operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, place.directory);
  if (journal.length !== 6 || journal[4].phase !== 'registration_cas'
    || journal[5].phase !== 'discovery_published') throw invalid();
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!(await readInstallBytes(place.marker, 1024, true))?.equals(marker)) throw invalid();
  const before = await readInstallBytes(place.before, 16384, true);
  const beforeRevision = before === null ? 'absent' : hash(before);
  const candidate = await readNndSelectedActivationCandidate(identity, serviceLease, registryLease,
    options.stageOperationId, marker, beforeRevision);
  if (journal[0].evidence_sha256 !== candidate.evidence_sha256
    || !(await readInstallBytes(place.candidate, 4096, true))?.equals(json(candidate.evidence))
    || state.package?.root !== candidate.package.root || state.package.version !== candidate.package.version
    || state.package.protocol !== candidate.package.protocol || state.package.entrypoint !== candidate.package.entrypoint) throw invalid();
  const childBytes = await readInstallBytes(place.child, 2048, true);
  const child = exactChild(childBytes, identity, options, candidate.package.version, state.child.child.pid);
  const desired = serializeManifestBytes({ root: candidate.package.root,
    version: candidate.package.version, protocol: candidate.package.protocol });
  const revision = hash(desired), childSha = hash(childBytes);
  const forward = await readLockedManifestOperation(registryLease, `nnd-activate-${options.operationId}`);
  const current = await readLockedManifestSnapshot(registryLease);
  if (candidate.evidence.desired_registration_sha256 !== revision || forward?.persistence !== 'saved'
    || forward.beforeRevision !== beforeRevision || forward.persistedRevision !== revision
    || !current.rawBytes?.equals(desired)) throw invalid();
  return { journal, child, childSha, revision, candidate, beforeRevision };
}
function verifyJournal(identity, options, evidence, record) {
  const { journal, child, childSha, revision, candidate, beforeRevision } = evidence;
  if (journal[1].evidence_sha256 !== hash(json({ operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
    data_id: identity.data_id, version: child.version, payload_sha256: candidate.evidence.payload_sha256 }))
    || journal[2].evidence_sha256 !== hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation: child.generation, version: child.version }))
    || journal[4].evidence_sha256 !== hash(json({ operation_id: options.operationId,
      before_revision: beforeRevision, after_revision: revision, child_sha256: childSha }))
    || journal[5].evidence_sha256 !== hash(json({ operation_id: options.operationId,
      registration_revision: revision, child_sha256: childSha, generation: options.generation,
      discovery_sha256: hash(json(record)) }))) throw invalid();
}
async function checkProcesses(state, child, options, signal) {
  liveState(state, options);
  let observed, parent;
  try {
    observed = await captureDiscoveryProcessIdentity(signal, child.process_identity.pid);
    parent = await captureDiscoveryProcessIdentity(signal);
  } catch { throw invalid(); }
  if (!isDeepStrictEqual(observed, child.process_identity)
    || !isDeepStrictEqual(parent, state.record.process_identity)) throw invalid();
}
async function boundedHealth(response, url, expectedStatus) {
  if (response.status !== expectedStatus || response.redirected || response.url !== url) throw invalid();
  if (expectedStatus === 401) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks = []; let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 4096) { await reader.cancel(); throw invalid(); }
    chunks.push(item.value);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw invalid(); }
}
async function probeHealth(identity, state, record, fetchImpl, signal) {
  const snapshot = state.native.runtime.snapshot();
  if (!['ready', 'setup_required'].includes(snapshot?.service_state)) throw invalid();
  const nativeUrl = `${state.native.endpoint}/v1/health`;
  const native = await boundedHealth(await fetchImpl(nativeUrl, { redirect: 'error', signal,
    headers: { authorization: `Bearer ${state.native.token}` } }), nativeUrl, 200);
  if (native?.instance_id !== identity.installation_id || native.service_state !== snapshot.service_state) throw invalid();
  const uiUrl = `${state.ui}/health`;
  const ui = await boundedHealth(await fetchImpl(uiUrl, { redirect: 'error', signal }), uiUrl, 200);
  if (ui?.ok !== true || ui.runtime !== 'service') throw invalid();
  // Security: public health is anonymous and can be spoofed after the child closes its listener.
  const nonce = randomBytes(32).toString('base64url');
  const proofUrl = `${state.ui}/__nna/health-proof`;
  const proof = await boundedHealth(await fetchImpl(proofUrl, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) }), proofUrl, 200);
  if (!exactRecord(proof, ['protocol', 'mac']) || proof.protocol !== '1.0'
    || typeof proof.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.mac)) throw invalid();
  const expected = createHmac('sha256', Buffer.from(state.uiHealthKey, 'base64url'))
    .update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce, identity.installation_id,
      identity.data_id, record.instance_id, state.ui])).digest();
  if (!timingSafeEqual(Buffer.from(proof.mac, 'hex'), expected)) throw invalid();
  for (const [method, path] of [['GET', 'status'], ['POST', 'attach']]) {
    const url = `${record.endpoint}/${path}`;
    await boundedHealth(await fetchImpl(url, { method, redirect: 'error', signal,
      headers: { authorization: `Bearer ${record.control_token}`, 'x-nnd-generation': record.instance_id } }), url, 401);
  }
  if (state.native.runtime.snapshot()?.service_state !== snapshot.service_state) throw invalid();
  return snapshot.service_state;
}
async function verifyOwned(identity, state, serviceLease, registryLease, options, signal) {
  signal.throwIfAborted(); liveState(state, options);
  const evidence = await selectedEvidence(identity, state, serviceLease, registryLease, options);
  const record = await readNndPrivateDiscoveryGeneration(identity, serviceLease, options.generation);
  if (!isDeepStrictEqual(record, state.record)
    || !isDeepStrictEqual(await readNndServiceDiscovery(identity), record)) throw invalid();
  verifyJournal(identity, options, evidence, record);
  await checkProcesses(state, evidence.child, options, signal);
  const serviceState = await probeHealth(identity, state, record, options.fetchImpl ?? fetch, signal);
  if (typeof state.controller.probeDark !== 'function') throw invalid();
  const dark = await state.controller.probeDark(record, { signal, timeoutMs: 5000 });
  if (!exactRecord(dark, ['protocol', 'installation_id', 'data_id', 'generation', 'endpoint', 'service_state'])
    || dark.protocol !== '1.0' || dark.installation_id !== identity.installation_id
    || dark.data_id !== identity.data_id || dark.generation !== options.generation
    || dark.endpoint !== state.ui || dark.service_state !== serviceState) throw invalid();
  await checkProcesses(state, evidence.child, options, signal);
  if (state.native.runtime.snapshot()?.service_state !== serviceState || state.controller.isListening?.() !== true) throw invalid();
  const after = await selectedEvidence(identity, state, serviceLease, registryLease, options);
  const privateAfter = await readNndPrivateDiscoveryGeneration(identity, serviceLease, options.generation);
  verifyJournal(identity, options, after, privateAfter);
  if (after.childSha !== evidence.childSha || after.revision !== evidence.revision
    || after.journal[5].receipt_sha256 !== evidence.journal[5].receipt_sha256
    || !isDeepStrictEqual(privateAfter, record)
    || !isDeepStrictEqual(await readNndServiceDiscovery(identity), record)) throw invalid();
  signal.throwIfAborted();
  return Object.freeze({ state: 'published_healthy_unresolved', operation_id: options.operationId,
    generation: options.generation, registration_revision: evidence.revision,
    journal_sha256: evidence.journal[5].receipt_sha256, native_state: serviceState });
}

// Dormant held-live continuation only. A published pointer is unresolved until
// same-process principal promotion, durable completion, and live owner transfer.
export async function verifyNndPublishedTrialHealthUnderOwnership(identity, state, serviceLease, registryLease, options = {}) {
  assertOwner(identity, serviceLease, registryLease, options);
  liveState(state, options);
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function'
    || options.afterVerified !== undefined && typeof options.afterVerified !== 'function') throw invalid();
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id,
    leaseSignal => runManifestLeaseWork(registryLease, async () => {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(timeoutMs),
        ...(options.signal ? [options.signal] : [])]);
      try {
        const health = await verifyOwned(identity, state, serviceLease, registryLease, options, signal);
        if (options.afterVerified) {
          // Security: this proof exists only inside the final verified, held-owner
          // callback. Async work cannot retain it after the callback returns.
          const issued = issueNndPrincipalTransitionProof(identity, state, serviceLease, registryLease,
            options, health, signal);
          try {
            const result = options.afterVerified(Object.freeze({ proof: issued.proof, health }));
            if (result && typeof result.then === 'function') {
              // Rejecting an async callback must not leave its later rejection
              // unhandled and crash the owner while the activation is unresolved.
              void Promise.resolve(result).catch(() => {});
              throw invalid();
            }
          } finally { issued.retire(); }
        }
        return health;
      }
      catch { throw invalid(); }
    }), { timeoutMs: 300000 });
}
