// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease } from './persistence/manifest-lock.js';
import { operationValid } from './nnd-install-storage.js';

const GATES = new WeakMap();
const invalid = () => new ContractError('nnd_trial_admission_invalid',
  'Unpublished NND trial ownership changed; native requests are unavailable.');
const mutationDenied = () => new ContractError('nnd_trial_mutation_denied',
  'Unpublished NND trial cannot perform native mutations.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** A closed-only native admission gate for this exact unpublished generation.
 * It has no opening method; durable completion and transfer must be designed
 * before ordinary writes can be admitted on the same listener. */
export function createNndTrialAdmissionGate(identity, state, serviceLease, registryLease, binding) {
  if (!identity || state?.identity !== identity || state.lease !== serviceLease
    || !state.unpublishedTrial || state.published || state.stopping
    || !operationValid(binding?.operationId) || !operationValid(binding?.stageOperationId)
    || state.activationOperationId !== binding.operationId || state.stageOperationId !== binding.stageOperationId
    || !operationValid(state.record?.instance_id)) throw invalid();
  const gate = Object.freeze({});
  const entry = { identity, installationId: identity.installation_id, dataId: identity.data_id,
    dataRoot: identity.data_root, state, serviceLease, registryLease, operationId: binding.operationId,
    stageOperationId: binding.stageOperationId, generation: state.record.instance_id };
  assertNndTrialRequestAdmissionInternal(entry, 'GET');
  GATES.set(gate, entry);
  return gate;
}

export function assertNndTrialRequestAdmission(gate, identity, request) {
  const entry = GATES.get(gate);
  if (!entry || entry.identity !== identity) throw invalid();
  assertNndTrialRequestAdmissionInternal(entry, request?.method);
}

function assertNndTrialRequestAdmissionInternal(entry, method) {
  const { identity, state, serviceLease, registryLease } = entry;
  if (identity.installation_id !== entry.installationId || identity.data_id !== entry.dataId
    || identity.data_root !== entry.dataRoot || state.identity !== identity || state.lease !== serviceLease || !state.unpublishedTrial
    || state.published || state.stopping || state.record?.instance_id !== entry.generation
    || state.activationOperationId !== entry.operationId || state.stageOperationId !== entry.stageOperationId
    || state.child?.failed || state.ui && !state.child?.child
    || state.child?.child?.exitCode !== undefined && state.child.child.exitCode !== null) throw invalid();
  try {
    assertHeldNndServiceLease(serviceLease, identity.data_id);
    const target = assertManifestLease(registryLease);
    if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
  } catch { throw invalid(); }
  if (method !== 'GET' && method !== 'HEAD') throw mutationDenied();
}
