// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease } from './persistence/manifest-lock.js';

const PROOFS = new WeakMap();
const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND same-process transition proof is unavailable; preserve the activation barrier.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

function owner(entry) {
  try {
    assertHeldNndServiceLease(entry.serviceLease, entry.identity.data_id);
    const target = assertManifestLease(entry.registryLease);
    if (!samePath(target.path, join(entry.identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
  } catch { throw invalid(); }
}

/** Private, short-lived bridge from exact post-publication health to a later
 * transition callback. It does not promote the principal or retire the barrier. */
export function issueNndPrincipalTransitionProof(identity, state, serviceLease, registryLease, options, health, signal) {
  if (health?.state !== 'published_healthy_unresolved' || health.operation_id !== options?.operationId
    || health.generation !== options?.generation || !/^[a-f0-9]{64}$/u.test(health.registration_revision)
    || !/^[a-f0-9]{64}$/u.test(health.journal_sha256) || !['ready', 'setup_required'].includes(health.native_state)
    || state?.published || state?.stopping || !state?.registrationSelected || state.record?.instance_id !== health.generation
    || !state.native || !state.child?.child || state.child.failed || state.child.child.exitCode !== null
    || !Number.isSafeInteger(state.child.child.pid) || state.child.child.pid < 1
    || state.controller?.isListening?.() !== true || state.native.isListening?.() !== true
    || signal?.aborted || !identity?.installation_id || !identity?.data_id) throw invalid();
  const entry = { identity, state, serviceLease, registryLease, operationId: options.operationId,
    stageOperationId: options.stageOperationId, generation: options.generation, health,
    native: state.native, child: state.child.child, record: state.record, signal,
    deadline: Date.now() + 5000, active: true };
  owner(entry);
  const proof = Object.freeze({});
  PROOFS.set(proof, entry);
  return Object.freeze({ proof, retire: () => { entry.active = false; } });
}

/** One successful or failed consumption burns the proof. The returned values
 * remain unresolved evidence, never permission to expose public attach. */
export function consumeNndPrincipalTransitionProof(proof, identity, state, serviceLease, registryLease, options) {
  const entry = PROOFS.get(proof);
  if (!entry?.active) throw invalid();
  entry.active = false;
  if (Date.now() > entry.deadline || entry.signal?.aborted
    || identity !== entry.identity || state !== entry.state
    || serviceLease !== entry.serviceLease || registryLease !== entry.registryLease
    || options?.operationId !== entry.operationId || options?.stageOperationId !== entry.stageOperationId
    || options?.generation !== entry.generation || state.native !== entry.native
    || state.child?.child !== entry.child || state.record !== entry.record
    || state.published || state.stopping || !state.registrationSelected || state.child.failed
    || state.child.child.exitCode !== null || state.controller?.isListening?.() !== true
    || state.native.isListening?.() !== true) throw invalid();
  owner(entry);
  return Object.freeze({ operation_id: entry.operationId, stage_operation_id: entry.stageOperationId,
    generation: entry.generation, registration_revision: entry.health.registration_revision,
    journal_sha256: entry.health.journal_sha256, native_state: entry.health.native_state });
}
