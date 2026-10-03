// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease } from './persistence/manifest-lock.js';
import { operationValid } from './nnd-install-storage.js';
import { consumeNndClearedAdmissionProof } from './nnd-activation-retirement-cleanup.js';

const GATES = new WeakMap();
const invalid = () => new ContractError('nnd_trial_admission_invalid',
  'Unpublished NND trial ownership changed; native requests are unavailable.');
const mutationDenied = () => new ContractError('nnd_trial_mutation_denied',
  'Unpublished NND trial cannot perform native mutations.');
const promotionPending = () => new ContractError('nnd_trial_admission_invalid',
  'Promoted NND trial accepts only private health until completion is durable.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** The native gate stays quarantined until exact retained-owner clearance is consumed. */
export function createNndTrialAdmissionGate(identity, state, serviceLease, registryLease, binding) {
  if (!identity || state?.identity !== identity || state.lease !== serviceLease
    || !state.unpublishedTrial || state.published || state.stopping
    || !operationValid(binding?.operationId) || !operationValid(binding?.stageOperationId)
    || state.activationOperationId !== binding.operationId || state.stageOperationId !== binding.stageOperationId
    || !operationValid(state.record?.instance_id)) throw invalid();
  const gate = Object.freeze({});
  const entry = { identity, installationId: identity.installation_id, dataId: identity.data_id,
    dataRoot: identity.data_root, state, serviceLease, registryLease, operationId: binding.operationId,
    stageOperationId: binding.stageOperationId, generation: state.record.instance_id, transferred: false };
  assertNndTrialOwnerInternal(entry);
  GATES.set(gate, entry);
  return gate;
}

export function assertNndTrialOwnership(gate, identity) {
  const entry = GATES.get(gate);
  if (!entry || entry.identity !== identity) throw invalid();
  assertNndTrialOwnerInternal(entry);
}

export function assertNndTrialRequestAdmission(gate, identity, request) {
  const entry = GATES.get(gate);
  if (!entry || entry.identity !== identity) throw invalid();
  assertNndTrialOwnerInternal(entry);
  if (entry.transferred) return;
  if (request?.method !== 'GET' && request?.method !== 'HEAD') throw mutationDenied();
  if (entry.state.nativePrincipalPromoted
    && (request.method !== 'GET' || request.url !== '/v1/health')) throw promotionPending();
}

/** Transfer only the live native listener; controller publication is a separate transition. */
export function transferNndTrialAdmissionGate(gate, identity, registryLease, proof) {
  const entry = GATES.get(gate);
  if (!entry || entry.identity !== identity || entry.registryLease !== registryLease || entry.transferred) throw invalid();
  assertNndTrialOwnerInternal(entry);
  if (!entry.state.retained || !entry.state.retainedLeaseArmed || !entry.state.nativePrincipalPromoted
    || !entry.state.registrationSelected || !entry.state.native?.isListening?.()
    || !entry.state.controller?.isListening?.()) throw invalid();
  const witness = consumeNndClearedAdmissionProof(proof, identity, entry.state, entry.serviceLease, registryLease);
  if (typeof witness !== 'string' || !/^[a-f0-9]{64}$/u.test(witness)) throw invalid();
  // Invariant: no await separates proof consumption and the one-way in-memory switch.
  entry.transferred = true;
  return Object.freeze({ state: 'native_admission_transferred_controller_dark', witness_sha256: witness });
}

function assertNndTrialOwnerInternal(entry) {
  const { identity, state, serviceLease, registryLease } = entry;
  if (identity.installation_id !== entry.installationId || identity.data_id !== entry.dataId
    || identity.data_root !== entry.dataRoot || state.identity !== identity || state.lease !== serviceLease || !state.unpublishedTrial
    || state.published || state.stopping || state.record?.instance_id !== entry.generation
    || state.activationOperationId !== entry.operationId || state.stageOperationId !== entry.stageOperationId
    || state.child?.failed || state.ui && !state.child?.child
    || state.child?.child?.exitCode !== undefined && state.child.child.exitCode !== null
    || state.nativePrincipalPromoted && (state.native?.isListening?.() !== true
      || state.controller?.isListening?.() !== true)) throw invalid();
  try {
    assertHeldNndServiceLease(serviceLease, identity.data_id);
    if (!entry.transferred) {
      const target = assertManifestLease(registryLease);
      if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
    } else if (!state.retained || !state.retainedLeaseArmed || !state.nativePrincipalPromoted
      || !state.registrationSelected || !state.native?.isListening?.()
      || !state.controller?.isListening?.()) throw invalid();
  } catch { throw invalid(); }
}
