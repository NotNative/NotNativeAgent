// SPDX-License-Identifier: Apache-2.0
/** Resumable exact evidence cleanup. Admission and the selected controller stay barred. */
import { join, resolve } from 'node:path';
import { opendir, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndExternalRetirementDecisionUnderOwnership } from './nnd-activation-retirement-decision.js';
import { parseNndTerminalRetirementPlanBytes } from './nnd-activation-retirement-plan.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { readInstallBytes, writeInstallNew, hash, json, operationValid } from './nnd-install-storage.js';
import { retirementCleanupPaths, inspectRetirementArtifacts,
  removeRetirementArtifact, assertRetirementBarrierAcl } from './nnd-activation-retirement-cleanup-files.js';

const invalid = () => new ContractError('nnd_activation_retirement_cleanup_invalid',
  'NND retirement cleanup is unresolved; preserve the pending barrier and remaining evidence.');
const ACTIVE = new WeakSet();
const CLEARED_ADMISSION_PROOFS = new WeakMap();
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!identity || !options || !operationValid(options.operationId)
    || !operationValid(options.stageOperationId) || !operationValid(options.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  if (!samePath(assertManifestLease(registryLease).path,
    join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function assertLive(state, identity, serviceLease, options) {
  if (state?.identity !== identity || state.lease !== serviceLease || !state.unpublishedTrial
    || !state.retained || !state.retainedLeaseArmed || state.stopping || state.published
    || state.child?.failed || !state.child?.child || state.child.child.exitCode !== null
    || !state.native?.isListening?.() || !state.controller?.isListening?.()
    || state.record?.instance_id !== options.generation || state.activationOperationId !== options.operationId
    || state.stageOperationId !== options.stageOperationId) throw invalid();
}
async function verify(context) {
  const { identity, state, serviceLease, registryLease, options, signal, place } = context;
  signal.throwIfAborted();
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  const proof = await readNndExternalRetirementDecisionUnderOwnership(identity, serviceLease, registryLease, options);
  if (proof.state !== 'retirement_decision_recorded_barred' || proof.marker_state !== 'present'
    || proof.pointer_state !== 'selected') throw invalid();
  const planBytes = await readInstallBytes(place.plan, 4096);
  const decisionBytes = await readInstallBytes(place.decision, 4096);
  if (hash(planBytes) !== proof.plan_sha256 || hash(decisionBytes) !== proof.decision_sha256
    || context.decisionSha && context.decisionSha !== proof.decision_sha256) throw invalid();
  const plan = parseNndTerminalRetirementPlanBytes(planBytes, identity, options);
  const decision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decisionBytes));
  const child = await captureDiscoveryProcessIdentity(signal, state.child.child.pid);
  if (!isDeepStrictEqual(child, decision.child_process_identity)
    || !isDeepStrictEqual(await readNndServiceDiscovery(identity), state.record)) throw invalid();
  const artifacts = await inspectRetirementArtifacts(place, options.operationId, plan, signal);
  assertLive(state, identity, serviceLease, options);
  signal.throwIfAborted();
  return { ...artifacts, plan, decision, decisionSha: proof.decision_sha256, planSha: proof.plan_sha256 };
}
async function clean(context) {
  let current = await verify(context);
  context.decisionSha = current.decisionSha;
  // Invariant: at most twelve recorded files and one directory can be retired; no inferred paths.
  for (let attempt = 0; attempt < 13; attempt++) {
    if (!current.present.length && !current.hasDirectory) break;
    await removeRetirementArtifact(context.place, context.options.operationId, current.plan, current.present[0]);
    current = await verify(context);
  }
  if (current.present.length || current.hasDirectory) throw invalid();
  return Object.freeze({ state: 'retirement_evidence_cleaned_barred', operation_id: context.options.operationId,
    generation: context.options.generation, decision_sha256: current.decisionSha, plan_sha256: current.planSha,
    marker_state: 'present', pointer_state: 'selected' });
}
/** The genuine retained owner must remain alive throughout cleanup; historical proof alone is insufficient. */
export async function cleanupNndRetirementEvidenceUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  if (ACTIVE.has(serviceLease)) throw invalid();
  ACTIVE.add(serviceLease);
  let started = false;
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    started = true;
    try {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000), ...(options.signal ? [options.signal] : [])]);
      return await clean({ identity, state, serviceLease, registryLease, options, signal,
        place: retirementCleanupPaths(identity, options.operationId) });
    } catch (cause) { throw new ContractError('nnd_activation_retirement_cleanup_invalid', invalid().message, { cause }); }
    finally { ACTIVE.delete(serviceLease); }
  }), { timeoutMs: 600000 }).catch(error => {
    // Invariant: a timed-out registered operation owns ACTIVE until its actual filesystem work settles.
    if (!started) ACTIVE.delete(serviceLease);
    throw error;
  });
}

/** A single-use, external proof that exact cleanup finished; all admission barriers stay in place. */
export async function recordNndTerminalRetirementCommitUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  if (ACTIVE.has(serviceLease)) throw invalid();
  ACTIVE.add(serviceLease);
  let started = false;
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    started = true;
    try {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000),
        ...(options.signal ? [options.signal] : [])]);
      const context = { identity, state, serviceLease, registryLease, options, signal,
        place: retirementCleanupPaths(identity, options.operationId) };
      const before = await verify(context);
      if (before.present.length || before.hasDirectory) throw invalid();
      const commit = { protocol: '1.0', state: 'terminal_committed_barred',
        operation_id: options.operationId, stage_operation_id: options.stageOperationId,
        installation_id: identity.installation_id, data_id: identity.data_id,
        generation: options.generation, plan_sha256: before.planSha,
        decision_sha256: before.decisionSha, completion_sha256: before.plan.completion_sha256,
        marker_sha256: before.plan.marker_sha256,
        registration_revision: before.decision.registration_revision,
        discovery_sha256: before.decision.discovery_sha256,
        child_process_identity: before.decision.child_process_identity };
      const content = json(commit);
      if (content.length > 4096) throw invalid();
      // Invariant: `wx` leaves an interrupted or uncertain write for explicit reconciliation.
      const checked = await verify(context);
      if (checked.present.length || checked.hasDirectory || checked.planSha !== before.planSha
        || checked.decisionSha !== before.decisionSha) throw invalid();
      signal.throwIfAborted();
      await writeInstallNew(context.place.terminal, content);
      const reopened = await readInstallBytes(context.place.terminal, 4096);
      if (!reopened.equals(content)) throw invalid();
      const after = await verify(context);
      if (after.present.length || after.hasDirectory || after.planSha !== before.planSha
        || after.decisionSha !== before.decisionSha) throw invalid();
      return Object.freeze({ state: 'terminal_committed_barred', operation_id: options.operationId,
        generation: options.generation, commit_sha256: hash(content), marker_state: 'present',
        pointer_state: 'selected' });
    } catch (cause) { throw new ContractError('nnd_activation_retirement_cleanup_invalid', invalid().message, { cause }); }
    finally { ACTIVE.delete(serviceLease); }
  }), { timeoutMs: 600000 }).catch(error => {
    if (!started) ACTIVE.delete(serviceLease);
    throw error;
  });
}

const TERMINAL_KEYS = ['protocol', 'state', 'operation_id', 'stage_operation_id', 'installation_id',
  'data_id', 'generation', 'plan_sha256', 'decision_sha256', 'completion_sha256',
  'marker_sha256', 'registration_revision', 'discovery_sha256', 'child_process_identity'];
const SHA = /^[a-f0-9]{64}$/u;
function canonicalRecord(bytes, keys) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || !json(value).equals(bytes)) throw invalid();
  return value;
}
function witnessFor(terminal, terminalSha) {
  return { protocol: '1.0', state: 'barriers_cleared_admission_barred',
    operation_id: terminal.operation_id, stage_operation_id: terminal.stage_operation_id,
    installation_id: terminal.installation_id, data_id: terminal.data_id,
    generation: terminal.generation, terminal_sha256: terminalSha,
    plan_sha256: terminal.plan_sha256, decision_sha256: terminal.decision_sha256,
    completion_sha256: terminal.completion_sha256, marker_sha256: terminal.marker_sha256,
    registration_revision: terminal.registration_revision, discovery_sha256: terminal.discovery_sha256,
    child_process_identity: terminal.child_process_identity };
}
async function inspectClearance(context) {
  const { identity, state, serviceLease, registryLease, options, signal, place } = context;
  signal.throwIfAborted();
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  const terminalBytes = await readInstallBytes(place.terminal, 4096);
  const terminal = canonicalRecord(terminalBytes, TERMINAL_KEYS);
  if (terminal.protocol !== '1.0' || terminal.state !== 'terminal_committed_barred'
    || terminal.operation_id !== options.operationId || terminal.stage_operation_id !== options.stageOperationId
    || terminal.installation_id !== identity.installation_id || terminal.data_id !== identity.data_id
    || terminal.generation !== options.generation
    || ![terminal.plan_sha256, terminal.decision_sha256, terminal.completion_sha256,
      terminal.marker_sha256, terminal.registration_revision, terminal.discovery_sha256].every(value => SHA.test(value))) throw invalid();
  const expected = witnessFor(terminal, hash(terminalBytes));
  const witnessBytes = await readInstallBytes(place.cleared, 4096, true);
  if (witnessBytes && !witnessBytes.equals(json(expected))) throw invalid();
  const present = [];
  for (const [name, expectedSha, limit] of [['marker', terminal.marker_sha256, 1024],
    ['plan', terminal.plan_sha256, 4096], ['decision', terminal.decision_sha256, 4096]]) {
    const bytes = await readInstallBytes(place[name], limit, true);
    if (!witnessBytes && !bytes || bytes && hash(bytes) !== expectedSha) throw invalid();
    if (bytes) present.push(name);
  }
  await noLinks(place.activations);
  for await (const _entry of await opendir(place.activations)) throw invalid();
  await assertRetirementBarrierAcl(place, [place.terminal, ...(witnessBytes ? [place.cleared] : []),
    ...present.map(name => place[name])], signal);
  const manifest = await readLockedManifestSnapshot(registryLease);
  if (!manifest.rawBytes || manifest.revision !== terminal.registration_revision
    || hash(manifest.rawBytes) !== terminal.registration_revision) throw invalid();
  const pointer = await readNndServiceDiscovery(identity);
  if (!pointer || pointer.instance_id !== options.generation || !isDeepStrictEqual(pointer, state.record)
    || hash(json(pointer)) !== terminal.discovery_sha256) throw invalid();
  const child = await captureDiscoveryProcessIdentity(signal, state.child.child.pid);
  if (!isDeepStrictEqual(child, terminal.child_process_identity)) throw invalid();
  assertLive(state, identity, serviceLease, options);
  signal.throwIfAborted();
  return { terminal, expected, witnessBytes, present };
}

/** Retire three external barriers only behind a durable witness; terminal commit still bars admission. */
export async function clearNndRetirementBarriersUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  if (ACTIVE.has(serviceLease)) throw invalid();
  ACTIVE.add(serviceLease);
  let started = false;
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    started = true;
    try {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000),
        ...(options.signal ? [options.signal] : [])]);
      const context = { identity, state, serviceLease, registryLease, options, signal,
        place: retirementCleanupPaths(identity, options.operationId) };
      let current = await inspectClearance(context);
      if (!current.witnessBytes) {
        // The full historical chain is still available before the first write.
        const proof = await verify(context);
        if (proof.present.length || proof.hasDirectory || proof.planSha !== current.terminal.plan_sha256
          || proof.decisionSha !== current.terminal.decision_sha256
          || proof.plan.completion_sha256 !== current.terminal.completion_sha256
          || proof.plan.marker_sha256 !== current.terminal.marker_sha256
          || proof.decision.registration_revision !== current.terminal.registration_revision
          || proof.decision.discovery_sha256 !== current.terminal.discovery_sha256
          || !isDeepStrictEqual(proof.decision.child_process_identity, current.terminal.child_process_identity)) throw invalid();
        current = await inspectClearance(context);
        signal.throwIfAborted();
        await writeInstallNew(context.place.cleared, json(current.expected));
        current = await inspectClearance(context);
        if (!current.witnessBytes) throw invalid();
      }
      for (const name of ['decision', 'plan', 'marker']) {
        if (!current.present.includes(name)) continue;
        const bytes = await readInstallBytes(context.place[name], name === 'marker' ? 1024 : 4096);
        if (hash(bytes) !== current.terminal[`${name}_sha256`]) throw invalid();
        signal.throwIfAborted();
        await unlink(context.place[name]);
        current = await inspectClearance(context);
      }
      if (current.present.length) throw invalid();
      return Object.freeze({ state: 'barriers_cleared_admission_barred',
        operation_id: options.operationId, generation: options.generation,
        witness_sha256: hash(current.witnessBytes), terminal_sha256: current.expected.terminal_sha256 });
    } catch (cause) { throw new ContractError('nnd_activation_retirement_cleanup_invalid', invalid().message, { cause }); }
    finally { ACTIVE.delete(serviceLease); }
  }), { timeoutMs: 600000 }).catch(error => {
    if (!started) ACTIVE.delete(serviceLease);
    throw error;
  });
}

/** Verify the completed clearance again under both genuine owners before transferring the live gate. */
export async function verifyNndClearedAdmissionUnderOwnership(identity, state, serviceLease, registryLease, options,
  transfer) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  if (!state.retainedLeaseArmed || !state.nativePrincipalPromoted || !state.registrationSelected
    || ACTIVE.has(serviceLease) || typeof transfer !== 'function') throw invalid();
  ACTIVE.add(serviceLease);
  let started = false;
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    started = true;
    try {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(600000),
        ...(options.signal ? [options.signal] : [])]);
      const context = { identity, state, serviceLease, registryLease, options, signal,
        place: retirementCleanupPaths(identity, options.operationId) };
      const current = await inspectClearance(context);
      if (!current.witnessBytes || current.present.length) throw invalid();
      const repeated = await inspectClearance(context);
      if (!repeated.witnessBytes?.equals(current.witnessBytes) || repeated.present.length) throw invalid();
      const proof = Object.freeze({});
      CLEARED_ADMISSION_PROOFS.set(proof, { identity, state, serviceLease, registryLease,
        generation: options.generation, witness: hash(current.witnessBytes) });
      try {
        // Invariant: transfer runs synchronously while both ownership work scopes still protect verification.
        const result = transfer(proof);
        if (result && typeof result.then === 'function') throw invalid();
        return result;
      } finally { CLEARED_ADMISSION_PROOFS.delete(proof); }
    } catch (cause) { throw new ContractError('nnd_activation_retirement_cleanup_invalid', invalid().message, { cause }); }
    finally { ACTIVE.delete(serviceLease); }
  }), { timeoutMs: 600000 }).catch(error => {
    if (!started) ACTIVE.delete(serviceLease);
    throw error;
  });
}

// Security: proof is one-use and bound to the exact live owner and generation, never to caller-shaped JSON.
export function consumeNndClearedAdmissionProof(proof, identity, state, serviceLease, registryLease) {
  const entry = CLEARED_ADMISSION_PROOFS.get(proof);
  CLEARED_ADMISSION_PROOFS.delete(proof);
  if (!entry || entry.identity !== identity || entry.state !== state || entry.serviceLease !== serviceLease
    || entry.registryLease !== registryLease || entry.generation !== state.record?.instance_id
    || !ACTIVE.has(serviceLease)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  if (!samePath(assertManifestLease(registryLease).path,
    join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
  assertLive(state, identity, serviceLease, { operationId: state.activationOperationId,
    stageOperationId: state.stageOperationId, generation: entry.generation });
  return entry.witness;
}
