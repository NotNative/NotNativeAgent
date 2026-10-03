// SPDX-License-Identifier: Apache-2.0
/** Resumable exact evidence cleanup. Admission and the selected controller stay barred. */
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndExternalRetirementDecisionUnderOwnership } from './nnd-activation-retirement-decision.js';
import { parseNndTerminalRetirementPlanBytes } from './nnd-activation-retirement-plan.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { readInstallBytes, hash, operationValid } from './nnd-install-storage.js';
import { retirementCleanupPaths, inspectRetirementArtifacts,
  removeRetirementArtifact } from './nnd-activation-retirement-cleanup-files.js';

const invalid = () => new ContractError('nnd_activation_retirement_cleanup_invalid',
  'NND retirement cleanup is unresolved; preserve the pending barrier and remaining evidence.');
const ACTIVE = new WeakSet();
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
  return { ...artifacts, plan, decisionSha: proof.decision_sha256, planSha: proof.plan_sha256 };
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
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(120000), ...(options.signal ? [options.signal] : [])]);
      return await clean({ identity, state, serviceLease, registryLease, options, signal,
        place: retirementCleanupPaths(identity, options.operationId) });
    } catch (cause) { throw new ContractError('nnd_activation_retirement_cleanup_invalid', invalid().message, { cause }); }
    finally { ACTIVE.delete(serviceLease); }
  }), { timeoutMs: 300000 }).catch(error => {
    // Invariant: a timed-out registered operation owns ACTIVE until its actual filesystem work settles.
    if (!started) ACTIVE.delete(serviceLease);
    throw error;
  });
}
