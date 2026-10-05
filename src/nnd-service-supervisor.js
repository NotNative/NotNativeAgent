// SPDX-License-Identifier: Apache-2.0
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { open, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { validateNndPackage } from './nnd-package.js';
import { acquireNndServiceLock, assertHeldNndServiceLease } from './nnd-service-lock.js';
import { createNndDiscoveryGeneration, publishNndDiscoveryGeneration, removeNndDiscoveryPointer,
  readNndServiceDiscovery, createNndTrialDiscoveryGeneration, discardNndTrialDiscoveryGeneration } from './nnd-service-discovery.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { startNndNativeService } from './nnd-service-native.js';
import { startNndController } from './nnd-service-controller.js';
import { launchNndServiceChild } from './nnd-service-child.js';
import { admitFreshNndServiceData } from './nnd-service-admission.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { consumeNndTrialCapability } from './nnd-activation-candidate.js';
import { createNndTrialAdmissionGate } from './nnd-trial-admission.js';
import { transferRetainedNativeAdmission } from './nnd-activation-native-admission-transfer.js';
import { publishRetainedNndController } from './nnd-activation-public-controller.js';
import { selectNndTrialRegistrationUnderOwnership } from './nnd-activation-registration.js';
import { publishNndSelectedDiscoveryUnderOwnership } from './nnd-activation-publication.js';
import { selectNndNativePrincipalUnderOwnership } from './nnd-activation-native-selection.js';
import { recordNndPrivateTicketUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { verifyNndHeldTicketUnderOwnership } from './nnd-activation-held-ticket.js';
import { probeNndPromotedPrivateAttachUnderOwnership } from './nnd-activation-promoted-private-attach.js';
import { recordNndPromotedAttachUnderOwnership } from './nnd-activation-promoted-attach-receipt.js';
import { recordNndCompletionUnderOwnership } from './nnd-activation-completion-receipt.js';
import { planNndTerminalRetirementUnderOwnership } from './nnd-activation-retirement-plan.js';
import { recordNndExternalRetirementDecisionUnderOwnership } from './nnd-activation-retirement-decision.js';
import { cleanupNndRetirementEvidenceUnderOwnership, recordNndTerminalRetirementCommitUnderOwnership,
  clearNndRetirementBarriersUnderOwnership } from './nnd-activation-retirement-cleanup.js';
import { userDataPaths } from './product.js';
const RETAINED_BY_LEASE = new WeakMap();
async function readMetadata(path) {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 16384) throw new Error('bound');
    const buffer = Buffer.alloc(16385); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error('bound');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
export async function admitNndServicePackage(paths, identity) {
  let stored;
  try { stored = await readMetadata(join(paths.config, 'nnd-package.json')); }
  catch (cause) { throw new ContractError('nnd_package_not_active', 'NND service requires a valid registered package', { cause }); }
  const info = await validateNndPackage(stored.root, { serviceHost: {
    platform: identity.platform, architecture: identity.architecture, node_major: identity.node_major,
    capabilities: ['service_supervision', 'setup_control_plane'], data_schemas: { nnd_catalog: 1, nnd_state: 1 },
  } });
  if (stored.version !== info.version || stored.protocol !== info.protocol) {
    throw new ContractError('nnd_registry_version_mismatch', 'Registered NND package changed');
  }
  const manifest = await readMetadata(info.manifestPath);
  return { ...info, entrypoint: await realpath(join(info.root, manifest.service_activation.entrypoint)) };
}
async function availableUiOrigin() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return origin;
}

export async function startNndSupervisor(identity, paths, options = {}) {
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  let session;
  try { session = createSupervisorSession(identity, lease, () => lease.close()); }
  catch (error) {
    try { await lease.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'NND ownership admission and cleanup failed'); }
    throw error;
  }
  const { state, stop, handle } = session;
  try {
    await assertNoNndInstallMarker(identity);
    state.package = await admitNndServicePackage(paths, identity);
    await admitFreshNndServiceData(paths, identity, lease);
    const previous = await readNndServiceDiscovery(identity);
    state.native = await startNndNativeService(paths, identity, options);
    state.controller = await startNndController({ getRecord: () => state.published ? state.record : null,
      status: () => status(state), stop, ticket: () => issueSupervisorTicket(state) });
    state.record = await createNndDiscoveryGeneration(identity, lease, { endpoint: state.controller.endpoint });
    await startSupervisorChild(session, paths);
    assertHeldNndServiceLease(lease, identity.data_id);
    await publishNndDiscoveryGeneration(identity, lease, state.record.instance_id, previous?.instance_id ?? null);
    state.published = true;
    monitorSupervisor(session);
    return handle;
  } catch (error) { return failSupervisorStart(session, error); }
}
function createSupervisorSession(identity, lease, releaseLease) {
  assertHeldNndServiceLease(lease, identity.data_id);
  const state = { identity, lease, releaseLease, native: null, child: null, controller: null, record: null,
    published: false, stopping: false, package: null, ui: null, failure: null };
  let resolveStop, closing;
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  const stop = () => {
    closing ??= closeSupervisor(state).then(resolveStop, error => {
      state.failure = error; resolveStop({ error }); throw error;
    });
    closing.catch(() => {}); return closing;
  };
  return { state, stop, handle: Object.freeze({ status: () => status(state), stop, stopped,
    recordCompletion: (registryLease, options) => recordRetainedCompletion(state, registryLease, options),
    planRetirement: (registryLease, options) => planRetainedRetirement(state, registryLease, options),
    recordRetirementDecision: (registryLease, options) => recordRetainedRetirementDecision(state, registryLease, options),
    cleanupRetirement: (registryLease, options) => cleanupNndRetirementEvidenceUnderOwnership(
      state.identity, state, state.lease, registryLease, options),
    commitRetirement: (registryLease, options) => recordNndTerminalRetirementCommitUnderOwnership(
      state.identity, state, state.lease, registryLease, options),
    clearRetirementBarriers: (registryLease, options) => clearNndRetirementBarriersUnderOwnership(
      state.identity, state, state.lease, registryLease, options),
    transferNativeAdmission: (registryLease, options) => transferRetainedNativeAdmission(state, registryLease, options),
    publishController: (registryLease, options) => publishRetainedNndController(state, registryLease, options) }) };
}
async function recordRetainedCompletion(state, registryLease, options) {
  if (!state.unpublishedTrial || !state.retainedLeaseArmed) {
    throw new ContractError('nnd_activation_transition_proof_invalid',
      'NND retained owner is unavailable for completion');
  }
  return recordNndCompletionUnderOwnership(state.identity, state, state.lease, registryLease, options);
}
async function planRetainedRetirement(state, registryLease, options) {
  if (!state.unpublishedTrial || !state.retainedLeaseArmed) {
    throw new ContractError('nnd_activation_retirement_invalid',
      'NND retained owner is unavailable for retirement planning');
  }
  return planNndTerminalRetirementUnderOwnership(state.identity, state, state.lease, registryLease, options);
}
async function recordRetainedRetirementDecision(state, registryLease, options) {
  if (!state.unpublishedTrial || !state.retainedLeaseArmed) {
    throw new ContractError('nnd_activation_retirement_decision_invalid',
      'NND retained owner is unavailable for a retirement decision');
  }
  return recordNndExternalRetirementDecisionUnderOwnership(state.identity, state, state.lease, registryLease, options);
}
// Security: the only exported trial entry consumes a one-use, receipt-bound native capability.
export async function startNndOwnedTrial(identity, paths, lease, registryLease, capability, options = {}) {
  const expected = userDataPaths({ environment: { NNA_HOME: identity.data_root } });
  const same = (left, right) => process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  if (!paths || Object.entries(expected).some(([key, value]) => typeof paths[key] !== 'string' || !same(paths[key], value))) {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial paths do not match the selected native data root');
  }
  const admitted = consumeNndTrialCapability(capability, identity, lease, registryLease);
  return startUnpublishedTrial(identity, paths, lease, admitted.package, options, registryLease,
    { operationId: admitted.activationOperationId, stageOperationId: admitted.stageOperationId });
}
async function startUnpublishedTrial(identity, paths, lease, admittedPackage, options = {}, registryLease = null, binding = null) {
  const session = createSupervisorSession(identity, lease, null);
  session.state.unpublishedTrial = true;
  session.state.package = admittedPackage;
  session.state.record = Object.freeze({ instance_id: randomUUID() });
  if (binding) {
    session.state.activationOperationId = binding.operationId;
    session.state.stageOperationId = binding.stageOperationId;
  }
  try {
    const admissionGate = registryLease && binding
      ? createNndTrialAdmissionGate(identity, session.state, lease, registryLease, binding) : null;
    session.state.trialAdmissionGate = admissionGate;
    session.state.native = await startNndNativeService(paths, identity, { ...options, unpublishedTrial: true, trialAdmissionGate: admissionGate });
    await startSupervisorChild(session, paths);
    monitorSupervisor(session);
    const finalOptions = options => {
      const bound = { operationId: session.state.activationOperationId,
        stageOperationId: session.state.stageOperationId, generation: session.state.record.instance_id };
      if (options && Object.entries(bound).some(([key, value]) => options[key] != null && options[key] !== value)) throw new ContractError('nnd_activation_transition_proof_invalid', 'NND activation identity changed');
      return { ...bound, ...options };
    };
    return Object.freeze({ ...session.handle, verify: (probeOptions) => verifyUnpublishedTrial(session.state, probeOptions), ...(registryLease ? { prepareDiscovery: () => prepareTrialDiscovery(session, registryLease), selectRegistration: options => selectTrialRegistration(session, registryLease, options), publishSelected: options => publishNndSelectedDiscoveryUnderOwnership(identity, session.state, lease, registryLease, finalOptions(options)), selectNativePrincipal: options => selectNndNativePrincipalUnderOwnership(identity, session.state, lease, registryLease, finalOptions(options)), recordPrivateTicket: options => recordNndPrivateTicketUnderOwnership(identity, session.state, lease, registryLease, finalOptions(options)), verifyHeldTicket: options => verifyNndHeldTicketUnderOwnership(identity, session.state, lease, registryLease, finalOptions(options)), promotePrivatePrincipal: options => session.state.native.promoteTrialPrincipal(session.state, lease, registryLease, finalOptions(options)), probePromotedPrivateAttach: options => probeNndPromotedPrivateAttachUnderOwnership(identity, session.state, lease, registryLease, finalOptions(options)), recordPromotedPrivateAttach: options => recordTrialPromotedAttach(session, registryLease, options), retainQuarantinedOwner: () => retainQuarantinedTrial(session), trialChildPid: () => session.state.child?.child?.pid ?? null, registrationSelected: () => session.state.registrationSelected === true } : {}) });
  } catch (error) { return failSupervisorStart(session, error); }
}
async function recordTrialPromotedAttach(session, registryLease, options) {
  const { state } = session;
  if (state.promotedAttachReceipt || state.retained) {
    throw new ContractError('nnd_activation_transition_proof_invalid',
      'NND promoted attach receipt has already been consumed');
  }
  const receipt = await recordNndPromotedAttachUnderOwnership(state.identity, state,
    state.lease, registryLease, options);
  if (receipt?.state !== 'promoted_attach_recorded_unresolved'
    || receipt.operation_id !== state.activationOperationId
    || receipt.generation !== state.record?.instance_id) {
    throw new ContractError('nnd_activation_transition_proof_invalid',
      'NND promoted attach receipt changed');
  }
  state.promotedAttachReceipt = receipt;
  return receipt;
}
function retainQuarantinedTrial(session) {
  const { state } = session;
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  if (!state.unpublishedTrial || state.stopping || state.retained || state.published
    || state.promotedAttachReceipt?.operation_id !== state.activationOperationId
    || state.promotedAttachReceipt?.generation !== state.record?.instance_id
    || !state.controller?.isListening() || !state.native?.isListening()
    || state.child?.failed || !state.ui || !state.record?.control_token) {
    throw new ContractError('nnd_activation_transition_proof_invalid',
      'Quarantined NND trial owner is unavailable');
  }
  // Invariant: the same live supervisor keeps the singleton lease. The native
  // quarantine and controller darkness remain until a separate terminal commit.
  state.retained = true;
  state.retainedOwner = session.handle;
  state.retainedStop = session.stop;
  RETAINED_BY_LEASE.set(state.lease, state);
  return session.handle;
}
// The trial's outer lease operation must settle before shutdown may close the
// singleton. Closing it inside that operation would wait on itself.
export async function armNndRetainedLeaseAfterTrial(serviceLease, expectedOwner = null) {
  const state = RETAINED_BY_LEASE.get(serviceLease);
  if (!state) {
    if (expectedOwner) throw new ContractError('nnd_activation_transition_proof_invalid',
      'NND retained owner was lost before lease handoff');
    return;
  }
  if (!expectedOwner || state.retainedOwner !== expectedOwner || state.stopping
    || state.child?.failed || !state.native?.isListening() || !state.controller?.isListening()
    || !['ready', 'setup_required'].includes(status(state).service_state)) {
    const changed = new ContractError('nnd_activation_transition_proof_invalid',
      'NND quarantined owner changed before lease handoff');
    try { await state.retainedStop(); }
    catch (stopError) { throw new AggregateError([changed, stopError],
      'NND quarantined owner handoff and shutdown are unresolved'); }
    if (state.shutdownComplete) {
      RETAINED_BY_LEASE.delete(serviceLease);
      await serviceLease.close();
    }
    throw changed;
  }
  assertHeldNndServiceLease(serviceLease, state.identity.data_id);
  RETAINED_BY_LEASE.delete(serviceLease);
  state.releaseLease = () => serviceLease.close();
  state.retainedLeaseArmed = true;
}
async function selectTrialRegistration(session, registryLease, options) {
  const { state } = session;
  if (state.registrationSelecting || state.registrationSelected || state.stopping || state.child?.failed
    || !state.controller || !state.record?.control_token || state.published) {
    throw new ContractError('nnd_activation_registration_invalid', 'Unpublished trial cannot select registration');
  }
  state.registrationSelecting = true;
  try {
    const result = await selectNndTrialRegistrationUnderOwnership(state.identity, state, state.lease,
      registryLease, { ...options, generation: state.record.instance_id });
    state.registrationSelected = true;
    return result;
  } finally { state.registrationSelecting = false; }
}
async function prepareTrialDiscovery(session, registryLease) {
  const { state } = session;
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  const target = assertManifestLease(registryLease);
  const expected = join(state.identity.data_root, 'config', 'nnd-package.json');
  const same = process.platform === 'win32'
    ? resolve(target.path).toLowerCase() === resolve(expected).toLowerCase()
    : resolve(target.path) === resolve(expected);
  if (!same) throw new ContractError('nnd_discovery_invalid', 'Unpublished NND trial registry ownership is invalid');
  if (state.discoveryPreparing || state.controller) {
    throw new ContractError('nnd_discovery_invalid', 'Unpublished NND trial discovery is already prepared');
  }
  state.discoveryPreparing = true;
  const task = runManifestLeaseWork(registryLease, () => createTrialDiscoveryUnderOwnership(session));
  state.discoveryTask = task;
  try { return await task; }
  finally { state.discoveryPreparing = false; state.discoveryTask = null; }
}
async function createTrialDiscoveryUnderOwnership(session) {
  const { state, stop } = session;
  if (state.controller || state.stopping || state.child?.failed || !state.ui
    || !['ready', 'setup_required'].includes(status(state).service_state)) {
    throw new ContractError('nnd_discovery_invalid', 'Unpublished NND trial cannot prepare discovery');
  }
  state.controller = await startNndController({ getRecord: () => state.published ? state.record : null,
    status: () => status(state), stop, ticket: () => issueSupervisorTicket(state) });
  try {
    if (state.stopping) throw new ContractError('nnd_discovery_invalid', 'Unpublished NND trial is stopping');
    state.trialDiscoveryAttempted = true;
    const record = await createNndTrialDiscoveryGeneration(state.identity, state.lease,
      { endpoint: state.controller.endpoint, instanceId: state.record.instance_id });
    assertHeldNndServiceLease(state.lease, state.identity.data_id);
    if (record.instance_id !== state.record.instance_id || state.child.failed || state.stopping) {
      throw new ContractError('nnd_discovery_invalid', 'Unpublished NND trial generation changed');
    }
    state.record = record;
    return Object.freeze({ instance_id: record.instance_id, endpoint: record.endpoint });
  } catch (error) {
    const controller = state.controller;
    try { await controller.close(); state.controller = null; }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Unpublished NND controller shutdown is unconfirmed'); }
    throw error;
  }
}
async function verifyUnpublishedTrial(state, { timeoutMs = 5000, signal, fetchImpl = fetch } = {}) {
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    throw new ContractError('nnd_health_unavailable', 'NND trial health deadline is invalid');
  }
  const deadline = Date.now() + timeoutMs;
  let before = status(state);
  while (!state.stopping && !state.child?.failed && before.service_state === 'starting'
    && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    signal?.throwIfAborted();
    before = status(state);
  }
  if (state.stopping || state.child?.failed || !['ready', 'setup_required'].includes(before.service_state)
    || state.native.isListening?.() !== true || before.runtime_state !== 'ready' || before.endpoint !== state.ui
    || before.package_version !== state.package.version) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial is not healthy');
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
    : AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let nativeResponse;
  try {
    nativeResponse = await fetchImpl(`${state.native.endpoint}/v1/health`, { redirect: 'manual', signal: requestSignal,
      headers: { authorization: `Bearer ${state.native.token}` } });
  } catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NNA runtime did not respond'); }
  if (nativeResponse.status !== 200 || nativeResponse.redirected
    || nativeResponse.url !== `${state.native.endpoint}/v1/health`) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NNA runtime response is invalid');
  }
  const nativeBody = await boundedHealthBody(nativeResponse);
  if (nativeBody.service_state !== before.service_state || nativeBody.instance_id !== state.identity.installation_id) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NNA runtime identity or state changed');
  }
  let response;
  try {
    response = await fetchImpl(`${state.ui}/health`, { redirect: 'manual', signal: requestSignal });
  } catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI did not respond'); }
  if (response.status !== 200 || response.redirected || response.url !== `${state.ui}/health`) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI response is invalid');
  }
  const body = await boundedHealthBody(response);
  if (body?.ok !== true || body.runtime !== 'service') {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI health body is invalid');
  }
  await verifyTrialGuiProof(state, requestSignal, fetchImpl);
  const after = status(state);
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  if (state.child.failed || state.stopping || state.native.isListening?.() !== true
    || after.service_state !== before.service_state
    || after.instance_id !== before.instance_id || after.endpoint !== before.endpoint) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial changed during health verification');
  }
  return Object.freeze({ installation_id: after.installation_id, data_id: after.data_id,
    generation: after.instance_id, version: after.package_version, native_state: after.service_state,
    gui_http_status: response.status });
}
async function verifyTrialGuiProof(state, requestSignal, fetchImpl) {
  // Security: a live child PID does not prove that it still owns its former UI port.
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state.uiHealthKey ?? '')) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof key is invalid');
  }
  const nonce = randomBytes(32).toString('base64url');
  const proofUrl = `${state.ui}/__nna/health-proof`;
  let proofResponse;
  try {
    proofResponse = await fetchImpl(proofUrl, { method: 'POST', redirect: 'manual', signal: requestSignal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  } catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof did not respond'); }
  if (proofResponse.status !== 200 || proofResponse.redirected || proofResponse.url !== proofUrl) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof response is invalid');
  }
  const proof = await boundedHealthBody(proofResponse);
  if (!proof || Object.keys(proof).sort().join(',') !== 'mac,protocol' || proof.protocol !== '1.0'
    || typeof proof.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.mac)) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof body is invalid');
  }
  const expected = createHmac('sha256', Buffer.from(state.uiHealthKey, 'base64url'))
    .update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce, state.identity.installation_id,
      state.identity.data_id, state.record.instance_id, state.ui])).digest();
  if (!timingSafeEqual(Buffer.from(proof.mac, 'hex'), expected)) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof identity differs');
  }
}
async function boundedHealthBody(response) {
  let body;
  try {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); throw new Error('bound'); }
      chunks.push(value);
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI health body is invalid'); }
  return body;
}
async function startSupervisorChild(session, paths) {
  const { state } = session, { identity } = state;
  assertHeldNndServiceLease(state.lease, identity.data_id);
  const nndData = join(identity.data_root, 'nnd'); await mkdir(nndData, { recursive: true });
  const ui_origin = await availableUiOrigin();
  state.uiHealthKey = randomBytes(32).toString('base64url');
  state.child = launchNndServiceChild(identity, state.package.entrypoint, {
    type: 'bootstrap', protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    generation: state.record.instance_id, nna_install_root: identity.install_root, nna_data_root: identity.data_root,
    nnd_data_root: await realpath(nndData), ui_origin, health_key: state.uiHealthKey,
    engine: { endpoint: state.native.endpoint, token: state.native.token },
  }, { version: state.package.version });
  await state.child.ready;
  assertHeldNndServiceLease(state.lease, identity.data_id);
  state.ui = ui_origin;
}
async function issueSupervisorTicket(state) {
  if (!state.published || !state.child || state.stopping) {
    throw new ContractError('nnd_service_not_running', 'NND UI is unavailable');
  }
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  return state.child.command('issue_ui_ticket');
}
function monitorSupervisor(session) {
  const { state, stop } = session;
  const failed = error => { if (!state.stopping) { state.failure = error; void stop(); } };
  state.child.exited.then(() => failed(new Error('NND child exited')));
  state.child.fatal.then(failed);
  state.lease.lost.then(error => { if (error) failed(error); });
}
async function failSupervisorStart(session, error) {
  try { await session.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'NND start and cleanup failed'); }
  throw error;
}
async function closeSupervisor(state) {
  state.stopping = true;
  state.retainedLeaseArmed = false;
  // Controller creation can outlive the call that initiated stop. Wait for
  // its registered task so shutdown cannot leave a late listener behind.
  if (state.unpublishedTrial && state.discoveryTask) await Promise.allSettled([state.discoveryTask]);
  const results = await Promise.allSettled([state.native?.close(), state.child?.close(),
    ...(state.unpublishedTrial ? [state.controller?.close()] : [])]);
  const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
  // Invariant: uncertain writers retain both the process and singleton lease for operator diagnosis.
  if (errors.length) throw new AggregateError(errors, 'NND shutdown incomplete; singleton remains held');
  if (state.trialDiscoveryAttempted) await retireStoppedTrialDiscovery(state);
  // Trial retirement already removed the pointer; a second remove would conflict.
  if (state.published && !state.trialDiscoveryRetired) await removeNndDiscoveryPointer(state.identity, state.lease, state.record.instance_id);
  if (!state.unpublishedTrial) await state.controller?.close();
  state.shutdownComplete = true;
  await state.releaseLease?.();
}
async function retireStoppedTrialDiscovery(state) {
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  const generation = state.record?.instance_id;
  if (!generation) throw new ContractError('nnd_discovery_invalid',
    'Stopped NND trial has no selected discovery generation; retain its owner and admission barrier');
  // Invariant: a retained trial can have a published current.json while its
  // in-memory public controller remains dark. The pointer is authoritative.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pointer = await readNndServiceDiscovery(state.identity);
    if (pointer === null) break;
    if (pointer.instance_id !== generation || !isDeepStrictEqual(pointer, state.record)) {
      throw new ContractError('nnd_discovery_conflict',
        'Stopped NND trial discovery belongs to another owner; preserve the singleton and barrier');
    }
    // The private discovery writer can commit removal before its response is
    // lost. Reopen the pointer, and retry only if the exact own record remains.
    try { await removeNndDiscoveryPointer(state.identity, state.lease, generation); }
    catch { /* Exact readback below decides whether the write committed. */ }
    const after = await readNndServiceDiscovery(state.identity);
    if (after === null) break;
    if (after.instance_id !== generation || !isDeepStrictEqual(after, state.record)) {
      throw new ContractError('nnd_discovery_conflict',
        'NND discovery changed during retained trial shutdown; preserve the singleton and barrier');
    }
    if (attempt === 1) throw new ContractError('nnd_discovery_invalid',
      'NND discovery removal is unconfirmed; preserve the singleton and barrier');
  }
  // Discard is idempotent when pointer removal already deleted the private
  // generation. A failed discard still retains the singleton for diagnosis.
  await discardNndTrialDiscoveryGeneration(state.identity, state.lease, generation);
  state.trialDiscoveryRetired = true;
}
function status(state) {
  const runtime = state.native?.runtime.snapshot();
  let service_state = state.stopping ? 'stopping' : runtime?.service_state ?? 'starting';
  if (!state.ui && !state.stopping) service_state = 'starting';
  if (state.ui && service_state === 'failed') service_state = 'degraded';
  const live = ['ready', 'setup_required', 'degraded'].includes(service_state);
  const failure_code = service_state === 'setup_required' ? 'nnd_setup_required'
    : service_state === 'degraded' ? 'nnd_service_crashed' : null;
  return { service_state, failure_code, installation_id: state.identity.installation_id, data_id: state.identity.data_id,
    instance_id: state.record?.instance_id ?? null, endpoint: live ? state.ui : null,
    package_version: state.package?.version ?? null, protocol: '1.0', runtime_state: state.ui ? 'ready' : 'starting',
    package_state: state.package ? 'ready' : 'absent', provider_state: 'unknown',
    setup_guidance: failure_code ? 'Repair native NNA configuration, then activate the setup runtime.' : null };
}
