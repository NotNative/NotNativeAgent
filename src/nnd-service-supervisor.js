// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { open, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { validateNndPackage } from './nnd-package.js';
import { acquireNndServiceLock, assertHeldNndServiceLease } from './nnd-service-lock.js';
import { createNndDiscoveryGeneration, publishNndDiscoveryGeneration, removeNndDiscoveryPointer,
  readNndServiceDiscovery } from './nnd-service-discovery.js';
import { startNndNativeService } from './nnd-service-native.js';
import { startNndController } from './nnd-service-controller.js';
import { launchNndServiceChild } from './nnd-service-child.js';
import { admitFreshNndServiceData } from './nnd-service-admission.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { consumeNndTrialCapability } from './nnd-activation-candidate.js';
import { userDataPaths } from './product.js';

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
  return { state, stop, handle: Object.freeze({ status: () => status(state), stop, stopped }) };
}
// Security: the only exported trial entry consumes a one-use, receipt-bound native capability.
export async function startNndOwnedTrial(identity, paths, lease, registryLease, capability, options = {}) {
  const expected = userDataPaths({ environment: { NNA_HOME: identity.data_root } });
  const same = (left, right) => process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  if (!paths || Object.entries(expected).some(([key, value]) => typeof paths[key] !== 'string' || !same(paths[key], value))) {
    throw new ContractError('nnd_activation_candidate_invalid', 'NND trial paths do not match the selected native data root');
  }
  const admittedPackage = consumeNndTrialCapability(capability, identity, lease, registryLease);
  return startUnpublishedTrial(identity, paths, lease, admittedPackage, options);
}
async function startUnpublishedTrial(identity, paths, lease, admittedPackage, options = {}) {
  const session = createSupervisorSession(identity, lease, null);
  session.state.package = admittedPackage;
  session.state.record = Object.freeze({ instance_id: randomUUID() });
  try {
    session.state.native = await startNndNativeService(paths, identity, { ...options, unpublishedTrial: true });
    await startSupervisorChild(session, paths);
    monitorSupervisor(session);
    return Object.freeze({ ...session.handle, verify: (probeOptions) => verifyUnpublishedTrial(session.state, probeOptions) });
  } catch (error) { return failSupervisorStart(session, error); }
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
    || before.runtime_state !== 'ready' || before.endpoint !== state.ui
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
  const after = status(state);
  assertHeldNndServiceLease(state.lease, state.identity.data_id);
  if (state.child.failed || state.stopping || after.service_state !== before.service_state
    || after.instance_id !== before.instance_id || after.endpoint !== before.endpoint) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND trial changed during health verification');
  }
  return Object.freeze({ installation_id: after.installation_id, data_id: after.data_id,
    generation: after.instance_id, version: after.package_version, native_state: after.service_state,
    gui_http_status: response.status });
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
  state.child = launchNndServiceChild(identity, state.package.entrypoint, {
    type: 'bootstrap', protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    generation: state.record.instance_id, nna_install_root: identity.install_root, nna_data_root: identity.data_root,
    nnd_data_root: await realpath(nndData), ui_origin, engine: { endpoint: state.native.endpoint, token: state.native.token },
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
  const results = await Promise.allSettled([state.native?.close(), state.child?.close()]);
  const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
  // Invariant: uncertain writers retain both the process and singleton lease for operator diagnosis.
  if (errors.length) throw new AggregateError(errors, 'NND shutdown incomplete; singleton remains held');
  if (state.published) await removeNndDiscoveryPointer(state.identity, state.lease, state.record.instance_id);
  await state.controller?.close(); await state.releaseLease?.();
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
