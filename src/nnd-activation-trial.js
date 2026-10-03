// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { prepareNndActivationUnderOwnership } from './nnd-activation-preparation.js';
import { issueNndTrialCapability } from './nnd-activation-candidate.js';
import { appendNndActivationPhase } from './nnd-activation-journal.js';
import { startNndOwnedTrial } from './nnd-service-supervisor.js';
import { hash, json, operationValid, readInstallBytes } from './nnd-install-storage.js';

const STOPPED = new WeakMap();

function assertTrialOwner(identity, serviceLease, registryLease, options) {
  if (!operationValid(options.stageOperationId) || !operationValid(options.operationId)) {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial operation identity is invalid');
  }
  if (options.continuation !== undefined && typeof options.continuation !== 'function') {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial continuation is invalid');
  }
  if (options.afterStop !== undefined && typeof options.afterStop !== 'function') {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND post-stop continuation is invalid');
  }
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  const registryPath = join(identity.data_root, 'config', 'nnd-package.json');
  const same = process.platform === 'win32'
    ? resolve(target.path).toLowerCase() === resolve(registryPath).toLowerCase()
    : resolve(target.path) === resolve(registryPath);
  if (!same) throw new ContractError('nnd_activation_candidate_invalid', 'NND trial registry ownership is invalid');
}

async function stoppedChildEvidence(identity, operationId, generation, version, pid) {
  const path = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations', `${operationId}.child.json`);
  const bytes = await readInstallBytes(path, 2048, true);
  if (!bytes) return null;
  let child;
  try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ContractError('nnd_activation_registration_invalid', 'Stopped trial child evidence is invalid'); }
  const keys = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
  const processKeys = ['version', 'pid', 'platform', 'start_id'];
  if (!child || typeof child !== 'object' || Array.isArray(child)
    || Object.keys(child).length !== keys.length || keys.some(key => !Object.hasOwn(child, key))
    || !child.process_identity || typeof child.process_identity !== 'object'
    || Object.keys(child.process_identity).length !== processKeys.length
    || processKeys.some(key => !Object.hasOwn(child.process_identity, key))
    || child.protocol !== '1.0' || child.operation_id !== operationId
    || child.installation_id !== identity.installation_id || child.data_id !== identity.data_id
    || child.generation !== generation || child.version !== version
    || child.process_identity.version !== 1 || child.process_identity.pid !== pid
    || child.process_identity.platform !== 'win32'
    || !/^\d{1,32}$/u.test(child.process_identity.start_id) || !json(child).equals(bytes)) {
    throw new ContractError('nnd_activation_registration_invalid', 'Stopped trial child evidence changed');
  }
  return Object.freeze({ pid, start_id: child.process_identity.start_id, sha256: hash(bytes) });
}

export function consumeNndStoppedTrialProof(proof, identity, serviceLease, registryLease, options) {
  const state = STOPPED.get(proof);
  if (!state?.active || state.used || !state.childIdentity || state.signal.aborted
    || state.serviceLease !== serviceLease || state.registryLease !== registryLease
    || state.installationId !== identity?.installation_id || state.dataId !== identity?.data_id
    || state.operationId !== options?.operationId || state.stageOperationId !== options?.stageOperationId
    || state.generation !== options?.generation) {
    throw new ContractError('nnd_activation_shutdown_invalid', 'Confirmed NND trial shutdown proof is unavailable');
  }
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  const expected = join(identity.data_root, 'config', 'nnd-package.json');
  const same = process.platform === 'win32'
    ? resolve(target.path).toLowerCase() === resolve(expected).toLowerCase()
    : resolve(target.path) === resolve(expected);
  if (!same) {
    throw new ContractError('nnd_activation_shutdown_invalid', 'NND shutdown registry ownership changed');
  }
  state.used = true;
  return Object.freeze({ operation_id: state.operationId, stage_operation_id: state.stageOperationId,
    generation: state.generation, child_identity: state.childIdentity, signal: state.signal });
}

async function afterConfirmedStop(identity, serviceLease, registryLease, options, running, childPid, result, failure, signal) {
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  const expected = join(identity.data_root, 'config', 'nnd-package.json');
  const same = process.platform === 'win32'
    ? resolve(target.path).toLowerCase() === resolve(expected).toLowerCase()
    : resolve(target.path) === resolve(expected);
  if (!same) throw new ContractError('nnd_activation_shutdown_invalid', 'NND shutdown registry ownership changed');
  const childIdentity = await stoppedChildEvidence(identity, options.operationId,
    running.instance_id, running.package_version, childPid);
  const token = Object.freeze({});
  const state = { installationId: identity.installation_id, dataId: identity.data_id,
    serviceLease, registryLease, operationId: options.operationId, stageOperationId: options.stageOperationId,
    generation: running.instance_id, childIdentity, signal, active: true, used: false };
  STOPPED.set(token, state);
  const tasks = []; let accepting = true, output, callbackFailure;
  const withShutdownProof = operation => {
    if (!accepting || typeof operation !== 'function') {
      throw new ContractError('nnd_activation_shutdown_invalid', 'NND post-stop continuation has ended');
    }
    const task = Promise.resolve().then(() => operation(token));
    tasks.push(task); task.catch(() => {});
    return task;
  };
  try {
    output = await options.afterStop(Object.freeze({ operation_id: options.operationId,
      stage_operation_id: options.stageOperationId, generation: running.instance_id,
      prior_error: failure ?? null, trial_result: result ?? null,
      serviceLease, registryLease, signal, withShutdownProof }));
  } catch (error) { callbackFailure = error; }
  accepting = false;
  const settled = await Promise.allSettled(tasks);
  state.active = false;
  const taskFailure = settled.find(item => item.status === 'rejected');
  if (callbackFailure && taskFailure) throw new AggregateError([callbackFailure, taskFailure.reason],
    'NND post-stop continuation and owned task failed');
  if (taskFailure) throw taskFailure.reason;
  if (callbackFailure) throw callbackFailure;
  return output;
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
  let trial, running, childPid, result, failure;
  try {
    signal.throwIfAborted();
    trial = await startNndOwnedTrial(identity, paths, serviceLease, registryLease, capability);
    running = trial.status(); childPid = trial.trialChildPid?.();
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
  let postStopResult, postStopFailure;
  if (trial && running && options.afterStop) {
    try { postStopResult = await afterConfirmedStop(identity, serviceLease, registryLease,
      options, running, childPid, result, failure, signal); }
    catch (error) { postStopFailure = error; }
  }
  if (failure && postStopFailure) throw new AggregateError([failure, postStopFailure],
    'NND trial and post-stop continuation failed; activation remains unresolved');
  if (failure && options.afterStop) {
    const error = new AggregateError([failure], 'NND trial failed after confirmed shutdown; activation remains unresolved');
    error.post_stop_result = postStopResult;
    throw error;
  }
  if (failure) throw failure;
  if (postStopFailure) throw postStopFailure;
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  signal.throwIfAborted();
  return options.afterStop ? Object.freeze({ ...result, post_stop_result: postStopResult }) : result;
}

// The caller owns the genuine data-root lease and registry mutex for the entire
// operation. A rejected shutdown is unresolved writer ownership, not permission
// to release either lock or clear the pending activation barrier.
export async function runNndUnpublishedTrialUnderOwnership(identity, paths, serviceLease, registryLease,
  { stageOperationId, operationId, healthTimeoutMs = 5000, continuation, afterStop } = {}) {
  const options = { stageOperationId, operationId, healthTimeoutMs, continuation, afterStop };
  assertTrialOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease,
      () => liveTrial(identity, paths, serviceLease, registryLease, options, signal)),
    { timeoutMs: 60000 });
}
