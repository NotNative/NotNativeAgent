// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';
import { open, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { validateNndPackage } from './nnd-package.js';
import { acquireNndServiceLock } from './nnd-service-lock.js';
import { createNndDiscoveryGeneration, publishNndDiscoveryGeneration, removeNndDiscoveryPointer,
  readNndServiceDiscovery } from './nnd-service-discovery.js';
import { startNndNativeService } from './nnd-service-native.js';
import { startNndController } from './nnd-service-controller.js';
import { launchNndServiceChild } from './nnd-service-child.js';
import { admitFreshNndServiceData } from './nnd-service-admission.js';

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
  const state = { identity, lease, native: null, child: null, controller: null, record: null,
    published: false, stopping: false, package: null, ui: null, failure: null };
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  let closing;
  const stop = () => { closing ??= closeSupervisor(state).then(resolveStop, (error) => {
    state.failure = error; resolveStop({ error }); throw error;
  }); closing.catch(() => {}); return closing; };
  try {
    state.package = await admitNndServicePackage(paths, identity);
    await admitFreshNndServiceData(paths, identity);
    const previous = await readNndServiceDiscovery(identity);
    state.native = await startNndNativeService(paths, identity, options);
    state.controller = await startNndController({ getRecord: () => state.record, status: () => status(state),
      stop, ticket: async () => {
        if (!state.child || state.stopping) throw new ContractError('nnd_service_not_running', 'NND UI is unavailable');
        return state.child.command('issue_ui_ticket');
      } });
    state.record = await createNndDiscoveryGeneration(identity, lease, { endpoint: state.controller.endpoint });
    const nndData = join(identity.data_root, 'nnd'); await mkdir(nndData, { recursive: true });
    const ui_origin = await availableUiOrigin();
    state.child = launchNndServiceChild(identity, state.package.entrypoint, {
      type: 'bootstrap', protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
      generation: state.record.instance_id, nna_install_root: identity.install_root, nna_data_root: identity.data_root,
      nnd_data_root: await realpath(nndData), ui_origin, engine: { endpoint: state.native.endpoint, token: state.native.token },
    }, { version: state.package.version });
    await state.child.ready; state.ui = ui_origin;
    await publishNndDiscoveryGeneration(identity, lease, state.record.instance_id, previous?.instance_id ?? null);
    state.published = true;
    state.child.exited.then(() => { if (!state.stopping) { state.failure = new Error('NND child exited'); void stop(); } });
    state.child.fatal.then((error) => { if (!state.stopping) { state.failure = error; void stop(); } });
    lease.lost.then((error) => { if (error) { state.failure = error; void stop(); } });
    return { status: () => status(state), stop, stopped };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'NND start and cleanup failed'); }
    throw error;
  }
}
async function closeSupervisor(state) {
  state.stopping = true;
  const results = await Promise.allSettled([state.native?.close(), state.child?.close()]);
  const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
  // Invariant: uncertain writers retain both the process and singleton lease for operator diagnosis.
  if (errors.length) throw new AggregateError(errors, 'NND shutdown incomplete; singleton remains held');
  if (state.published) await removeNndDiscoveryPointer(state.identity, state.lease, state.record.instance_id);
  await state.controller?.close(); await state.lease.close();
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
