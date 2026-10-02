// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { prepareNndActivationUnderOwnership } from './nnd-activation-preparation.js';
import { issueNndTrialCapability } from './nnd-activation-candidate.js';
import { appendNndActivationPhase } from './nnd-activation-journal.js';
import { startNndOwnedTrial } from './nnd-service-supervisor.js';
import { hash, json, operationValid } from './nnd-install-storage.js';

function assertTrialOwner(identity, serviceLease, registryLease, options) {
  if (!operationValid(options.stageOperationId) || !operationValid(options.operationId)) {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial operation identity is invalid');
  }
  if (options.continuation !== undefined && typeof options.continuation !== 'function') {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial continuation is invalid');
  }
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  const registryPath = join(identity.data_root, 'config', 'nnd-package.json');
  const same = process.platform === 'win32'
    ? resolve(target.path).toLowerCase() === resolve(registryPath).toLowerCase()
    : resolve(target.path) === resolve(registryPath);
  if (!same) throw new ContractError('nnd_activation_candidate_invalid', 'NND trial registry ownership is invalid');
}

async function preparedTrial(identity, serviceLease, registryLease, options, signal) {
  signal.throwIfAborted();
  const prepared = await prepareNndActivationUnderOwnership(identity, serviceLease, registryLease,
    { stageOperationId: options.stageOperationId, operationId: options.operationId });
  // Preparation has a longer independent deadline. If our enclosing ownership
  // operation expired while it ran, leave the journal at prepared.
  signal.throwIfAborted();
  if (prepared.state !== 'prepared') throw new ContractError('nnd_activation_preparation_invalid', 'NND preparation did not complete');
  const capability = await issueNndTrialCapability(identity, serviceLease, registryLease,
    options.stageOperationId, options.operationId);
  signal.throwIfAborted();
  const bound = { ...identity, operation_id: options.operationId };
  const directory = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations', options.operationId);
  const intentHash = hash(json({ operation_id: options.operationId, stage_operation_id: options.stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    version: prepared.version, payload_sha256: prepared.payload_sha256 }));
  await appendNndActivationPhase(bound, directory, serviceLease, registryLease, 'trial_starting', intentHash);
  return { prepared, capability, bound, directory };
}

async function verifyAndContinue(identity, trial, prepared, running, context, options, signal) {
  const { bound, directory, serviceLease, registryLease } = context;
  await appendNndActivationPhase(bound, directory, serviceLease, registryLease, 'trial_running',
    hash(json({ installation_id: running.installation_id, data_id: running.data_id,
      generation: running.instance_id, version: running.package_version })));
  const proof = await trial.verify({ timeoutMs: options.healthTimeoutMs, signal });
  if (proof.installation_id !== identity.installation_id || proof.data_id !== identity.data_id
    || proof.generation !== running.instance_id || proof.version !== prepared.version) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial proof changed');
  }
  await appendNndActivationPhase(bound, directory, serviceLease, registryLease, 'trial_healthy', hash(json(proof)));
  // The continuation runs with this same live child and both original locks.
  // The default is a dormant verification probe; it does not activate NND.
  const selectionTasks = []; let acceptingSelection = true, continuationResult, continuationFailure;
  const selectRegistration = () => {
    if (!acceptingSelection) throw new ContractError('nnd_activation_registration_invalid',
      'Unpublished trial continuation has ended');
    const task = Promise.resolve().then(() => trial.selectRegistration({ operationId: options.operationId,
      stageOperationId: options.stageOperationId }));
    selectionTasks.push(task);
    task.catch(() => {}); // An unawaited attempt still belongs to this trial.
    return task;
  };
  try {
    continuationResult = await options.continuation?.(Object.freeze({ proof, status: trial.status,
      prepareDiscovery: trial.prepareDiscovery,
      selectRegistration, serviceLease, registryLease, signal }));
  } catch (error) { continuationFailure = error; }
  acceptingSelection = false;
  // A continuation cannot abandon or swallow an uncertain CAS, then stop the
  // child and report a healthy pre-selection result while that write is live.
  const settled = await Promise.allSettled(selectionTasks);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  if (continuationFailure) throw continuationFailure;
  const stillHealthy = await trial.verify({ timeoutMs: options.healthTimeoutMs, signal });
  if (stillHealthy.generation !== proof.generation || stillHealthy.native_state !== proof.native_state) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial changed during continuation');
  }
  return Object.freeze({ state: trial.registrationSelected?.() ? 'registration_selected_unresolved' : 'trial_healthy',
    operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, ...proof,
    ...(options.continuation ? { continuation_result: continuationResult } : {}) });
}

async function liveTrial(identity, paths, serviceLease, registryLease, options, signal) {
  const { prepared, capability, bound, directory } = await preparedTrial(identity, serviceLease, registryLease, options, signal);
  let trial, result, failure;
  try {
    signal.throwIfAborted();
    trial = await startNndOwnedTrial(identity, paths, serviceLease, registryLease, capability);
    const running = trial.status();
    if (running.installation_id !== identity.installation_id || running.data_id !== identity.data_id
      || running.package_version !== prepared.version || !running.instance_id) {
      throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial identity changed');
    }
    result = await verifyAndContinue(identity, trial, prepared, running,
      { bound, directory, serviceLease, registryLease }, options, signal);
  } catch (error) { failure = error; }
  if (trial) {
    try { await trial.stop(); }
    catch (stopError) {
      throw new AggregateError(failure ? [failure, stopError] : [stopError],
        'Unpublished NND trial shutdown is unconfirmed; retain both ownership locks and the admission barrier');
    }
  }
  if (failure) throw failure;
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  signal.throwIfAborted();
  return result;
}

// The caller owns the genuine data-root lease and registry mutex for the entire
// operation. A rejected shutdown is unresolved writer ownership, not permission
// to release either lock or clear the pending activation barrier.
export async function runNndUnpublishedTrialUnderOwnership(identity, paths, serviceLease, registryLease,
  { stageOperationId, operationId, healthTimeoutMs = 5000, continuation } = {}) {
  const options = { stageOperationId, operationId, healthTimeoutMs, continuation };
  assertTrialOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease,
      () => liveTrial(identity, paths, serviceLease, registryLease, options, signal)),
    { timeoutMs: 60000 });
}
