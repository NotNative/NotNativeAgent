// SPDX-License-Identifier: Apache-2.0
/** Native compatibility-service lifecycle action routes over
 * /v1/nnd/configuration/compatibility-service/actions.
 * Why: the six census operator_action rows (status/start/stop/enable/disable/run)
 * describe the Windows wiring whose authority lives in src/opencode/service.js —
 * this surface reuses those functions VERBATIM so pid identity checks, the
 * opencode-start session lock, the detached managed runtime, the login Startup
 * .vbs, and the OpenChamber user environment wiring stay exactly as shipped to
 * the CLI. status is a read action (nnd.configuration.read); start, stop,
 * enable, and disable are operator actions on the service surface itself with
 * their own right, nnd.service.manage, kept separate from the settings write
 * right because they reach outside the configuration file (a verified process
 * kill, a Startup-folder script, user-scope environment writes).
 * Receipts pin per-verb application classes: status observes (not_applied);
 * start reads the persisted wiring NOW into a fresh runtime (start_service);
 * stop is immediate (stop_service); enable/disable flip the persisted flag and
 * the login wiring whose wiring surface takes effect at the next service start
 * (next_service_start), with the immediate script install reported in the
 * receipt. run is refused honestly: it is the foreground managed runtime the
 * detached start and the login startup script drive; an HTTP handler cannot
 * host a surface that never returns (nnd_service_run_unsupported).
 * Invariants: the public status view is the domain's redacted view (the
 * password is a presence flag and a source string, never a value); a running
 * but unverified runtime is reported honestly (verified:false) instead of
 * silently treated as absent; stopping an unverified runtime refuses (503) so a
 * wrong-process kill can never ride identity drift; a disabled service still
 * reports both runtime and wiring absence.
 */
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { OPENCODE_PASSWORD_SOURCES } from './opencode/config.js';
import {
  disableOpencodeService, enableOpencodeService, opencodeServiceStatus,
  startOpencodeService, stopOpencodeService,
} from './opencode/service.js';

const BASE = '/v1/nnd/configuration/compatibility-service';
const READ = 'nnd.configuration.read';
const LIFECYCLE = 'nnd.service.manage';
const REQUEST_BYTES = 4096;
const RESPONSE_BYTES = 65_536;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[0-9a-f-]{36}$/u;
const CONTROL = /[\x00-\x1f\x7f]/u;
const invalid = () => new ContractError('nnd_service_action_invalid', 'Native compatibility-service action is invalid.');
const projection = () => new ContractError('nnd_service_projection_invalid', 'Compatibility-service action refused a drifted projection.');

export async function dispatchNndCompatibilityLifecycleRequest(request, response, context) {
  const path = context.url.pathname;
  if (!path.startsWith(`${BASE}/actions`)) return false;
  const action = path === `${BASE}/actions/status` ? 'status'
    : path.startsWith(`${BASE}/actions/`) ? path.slice(`${BASE}/actions/`.length) : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  const service = context.nndCompatibilityLifecycleService;
  if (!service || typeof service.status !== 'function' || typeof service.start !== 'function'
    || typeof service.stop !== 'function' || typeof service.enable !== 'function'
    || typeof service.disable !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native compatibility-service actions are unavailable.');
  }
  if (action === 'status') {
    requireIntegrationPermission(context.principal, READ);
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return sendBounded(response, projectAction(await service.status(), 'status', 'not_applied', true));
  }
  if (action !== 'start' && action !== 'stop' && action !== 'enable' && action !== 'disable'
    && action !== 'run') return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, LIFECYCLE);
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  if (action === 'run') {
    // The managed runtime is the foreground process the detached start and the
    // login startup script drive; hosting it inside the HTTP handler would
    // never return, and start already spawns exactly this runtime detached.
    throw new ContractError('nnd_service_run_unsupported',
      'the managed runtime runs through start or the login startup script, not this operator surface');
  }
  await readEmptyBody(request);
  const value = action === 'start' ? await service.start()
    : action === 'stop' ? await service.stop()
      : action === 'enable' ? await service.enable() : await service.disable();
  const application = action === 'start' ? 'start_service'
    : action === 'stop' ? 'stop_service' : 'next_service_start';
  return sendBounded(response, projectAction(value, action, application, true));
}

export function createNndCompatibilityLifecycleService({ paths, environment, installationId, dataId, scope = {} }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '') || typeof paths?.opencodeConfig !== 'string'
    || !paths.opencodeConfig || typeof paths?.opencode !== 'string' || !paths.opencode
    || typeof paths?.logs !== 'string' || !paths.logs) {
    throw invalid();
  }
  const merged = { environment: environment ?? process.env, ...scope };
  const identity = () => ({ installationId, dataId, operationId: randomUUID() });
  return Object.freeze({
    async status() {
      return { ...identity(), value: await opencodeServiceStatus({}, paths, merged) };
    },
    async start() {
      return { ...identity(), value: await startOpencodeService({}, paths, merged) };
    },
    async stop() {
      return { ...identity(), value: await stopOpencodeService({}, paths, merged) };
    },
    async enable() {
      return { ...identity(), value: await enableOpencodeService({}, paths, merged) };
    },
    async disable() {
      return { ...identity(), value: await disableOpencodeService({}, paths, merged) };
    },
  });
}

function sendBounded(response, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_BYTES) throw projection();
  return send(response, 200, value);
}

/** Every action projects through one envelope: {installationId, dataId, value}
 * for the observation, plus operationId for stateful actions. */
export function projectAction(value, action, application, withOperationId = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !ID.test(value.installationId ?? '') || !ID.test(value.dataId ?? '')) throw projection();
  const keys = new Set(Object.keys(value));
  const legal = withOperationId ? new Set(['dataId', 'installationId', 'operationId', 'value'])
    : new Set(['dataId', 'installationId', 'value']);
  if (keys.size !== legal.size || [...keys].some(key => !legal.has(key))) throw projection();
  if (withOperationId && (typeof value.operationId !== 'string' || !OPERATION_ID.test(value.operationId))) throw projection();
  const common = { schema_version: '1.0', installation_id: value.installationId, data_id: value.dataId,
    scope: 'user', action, application,
    ...(withOperationId ? { operation_id: value.operationId } : {}) };
  if (action === 'status') return { ...common, status: projectStatus(value.value) };
  if (!value.value || typeof value.value !== 'object') throw projection();
  if (action === 'start') return { ...common, ...projectStart(value.value) };
  if (action === 'stop') return { ...common, ...projectStop(value.value) };
  if (action !== 'enable' && action !== 'disable') throw projection();
  const body = new Set(Object.keys(value.value));
  if (body.size !== 3 || !['config', 'login', 'runtime'].every(key => body.has(key))) throw projection();
  return { ...common, service: projectService(value.value.config),
    login: projectLogin(value.value.login), runtime: projectRuntime(value.value.runtime) };
}

/** The domain's status action returns {service, runtime, login, environment,
 * stale_binding}; the absent-safe public view is the authority, so the surface
 * mirrors it exactly. */
function projectStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = new Set(Object.keys(value));
  if (keys.size !== 5 || !['environment', 'login', 'runtime', 'service', 'stale_binding'].every(key => keys.has(key))) {
    throw projection();
  }
  if (value.stale_binding !== true && value.stale_binding !== false) throw projection();
  return { service: projectService(value.service), runtime: projectRuntime(value.runtime),
    login: projectLogin(value.login), environment: projectObservation(value.environment),
    stale_binding: value.stale_binding };
}

/** startOpencodeService returns {started:true,pid,port,url,environment} (a fresh
 * detached runtime), {started:false,reason,runtime} after a lock loss, or
 * {started:false,reason:'already_running',runtime,environment}; the receipt
 * normalizes reason/pid/port/url and carries runtime only when the domain
 * observed one. */
function projectStart(value) {
  const keys = new Set(Object.keys(value));
  if (value.started !== true && value.started !== false) throw projection();
  if (value.started === true) {
    if (keys.size !== 5 || !['environment', 'pid', 'port', 'started', 'url'].every(key => keys.has(key))) {
      throw projection();
    }
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.port)
      || value.port < 1 || value.port > 65_535 || typeof value.url !== 'string'
      || value.url.length < 1 || value.url.length > 320 || CONTROL.test(value.url)) throw projection();
    return { started: true, reason: null, pid: value.pid, port: value.port, url: value.url,
      runtime: null, environment: projectEnvironment(value.environment) };
  }
  if ((keys.size !== 4 && keys.size !== 3) || !['reason', 'runtime', 'started'].every(key => keys.has(key))
    || (keys.size === 4 && !keys.has('environment'))) throw throwProjectionHelp(keys);
  if (value.reason !== 'already_starting' && value.reason !== 'already_running') throw throwProjectionHelp(keys);
  return { started: false, reason: value.reason, pid: null, port: null, url: null,
    runtime: projectRuntime(value.runtime), environment:
      keys.has('environment') ? projectEnvironment(value.environment) : null };
}

function throwProjectionHelp(keys) {
  throw new ContractError('nnd_service_projection_invalid', `compatibility-service projection drifted over ${[...keys].sort().join(',')} (${keys.size} keys).`);
}

/** stopOpencodeService returns {stopped:true,pid} or {stopped:false,
 * reason:'not_running'} plus the cleared/non-Windows environment view. */
function projectStop(value) {
  const keys = new Set(Object.keys(value));
  if (value.stopped !== true && value.stopped !== false) throw projection();
  if (value.stopped === true) {
    if (keys.size !== 3 || !['environment', 'pid', 'stopped'].every(key => keys.has(key))
      || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw projection();
    return { stopped: true, reason: null, pid: value.pid, environment: projectEnvironment(value.environment) };
  }
  if (keys.size !== 3 || !['environment', 'reason', 'stopped'].every(key => keys.has(key))
    || value.reason !== 'not_running') throw projection();
  return { stopped: false, reason: 'not_running', pid: null, environment: projectEnvironment(value.environment) };
}

function projectService(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || [...new Set(Object.keys(value))].sort().join(',') !== 'autostart_enabled,bind_url,configured,hostname,password_source,port,username') {
    throw projection();
  }
  if (value.autostart_enabled !== true && value.autostart_enabled !== false) throw projection();
  if (value.configured !== true && value.configured !== false) throw projection();
  if (value.password_source !== null && (typeof value.password_source !== 'string'
    || !OPENCODE_PASSWORD_SOURCES.includes(value.password_source))) throw projection();
  if (typeof value.username !== 'string' || value.username.length < 1 || value.username.length > 64
    || CONTROL.test(value.username)) throw projection();
  if (typeof value.hostname !== 'string' || value.hostname.length < 1 || value.hostname.length > 253
    || CONTROL.test(value.hostname)) throw projection();
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) throw projection();
  if (typeof value.bind_url !== 'string' || value.bind_url.length < 1 || value.bind_url.length > 320
    || CONTROL.test(value.bind_url) || !value.bind_url.startsWith('http://')
    || !value.bind_url.endsWith(`:${value.port}`)) throw projection();
  return { ...value };
}

/** The runtime grammar mirrors opencodeRuntimeStatus's variant set exactly:
 * every variant carries only the keys the identity comparison produced.
 * Variants: {running:false} · {running:false,stale:true} · {running:false,
 * stale:true,pid,reason:'dead'|'different'} · {running:false,stale:true,pid} ·
 * {running:true,verified:false,pid,legacy:true,port?,url?} ·
 * {running:true,verified:false,pid,port?,url?} ·
 * {running:true,verified:true,pid,port?,url?}. */
function projectRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = new Set(Object.keys(value));
  if ([...keys].some(key => !['running', 'pid', 'port', 'url', 'stale', 'verified', 'legacy', 'reason'].includes(key))) {
    throw projection();
  }
  if (typeof value.running !== 'boolean' || (value.running === true && value.pid === undefined)
    || (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || value.pid <= 0))) throw projection();
  if (value.url !== undefined && (typeof value.url !== 'string' || value.url.length < 1
    || value.url.length > 320 || CONTROL.test(value.url))) throw projection();
  if (value.port !== undefined && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535)) throw projection();
  if (value.reason !== undefined && value.reason !== 'dead' && value.reason !== 'different') throw projection();
  if (value.stale !== undefined && value.stale !== true) throw projection();
  if (value.verified !== undefined && value.verified !== true && value.verified !== false) throw projection();
  if (value.legacy !== undefined && value.legacy !== true) throw projection();
  if (value.running === true) {
    if (keys.has('reason') || keys.has('stale') || value.verified === undefined) throw projection();
    if (value.legacy !== undefined && value.verified !== false) throw projection();
    return { ...value };
  }
  if (keys.has('verified') || keys.has('legacy') || keys.has('port') || keys.has('url')) throw projection();
  if (keys.has('reason') && value.stale !== true) throw projection();
  return { ...value };
}

function projectLogin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.supported !== 'boolean') {
    throw projection();
  }
  if (new Set(Object.keys(value)).size > 4
    || [...new Set(Object.keys(value))].some(key => !['installed', 'script_path', 'supported', 'error'].includes(key))) {
    throw projection();
  }
  if (value.installed !== null && value.installed !== true && value.installed !== false) throw projection();
  if (value.script_path !== undefined && value.script_path !== null
    && (typeof value.script_path !== 'string' || value.script_path.length < 1
      || value.script_path.length > 1024 || CONTROL.test(value.script_path))) throw projection();
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1
    || value.error.length > 64 || CONTROL.test(value.error))) throw projection();
  if (value.error !== undefined && !(value.supported === true && value.installed === null)) throw projection();
  if (value.error === undefined && value.supported === true && value.installed === null) throw projection();
  return { supported: value.supported, installed: value.installed,
    script_path: value.script_path ?? null, ...(value.error !== undefined ? { error: value.error } : {}) };
}

/** The applied view from applyUserEnvironment ({supported, written, removed,
 * unchanged}) and clearRuntimeEnvironment ({supported, written:[], removed});
 * non-Windows runs report {supported:false} only. Lists are the wiring names
 * (≤4 entries), so a longer list means drift. */
function projectEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = [...new Set(Object.keys(value))];
  if (value.supported === false && keys.length === 1) return { supported: false };
  if (value.supported !== true) throw projection();
  if (keys.length !== 3 && keys.length !== 4) throw projection();
  if (keys.length === 3 && (value.written.length !== 0 || 'unchanged' in value)) throw projection();
  const listKeys = keys.length === 4 ? ['written', 'removed', 'unchanged'] : ['written', 'removed'];
  for (const key of listKeys) {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 4 || list.some(name => typeof name !== 'string'
      || name.length < 1 || name.length > 64 || CONTROL.test(name))) throw projection();
  }
  return { supported: true, written: value.written.slice(), removed: value.removed.slice(),
    ...(keys.length === 4 ? { unchanged: value.unchanged.slice() } : {}) };
}

/** The status view's environment observation: presence only (the OpenChamber
 * password never leaves the store; a boolean presence flag only). The non-Win
 * observation is {supported:false, ...nulls}; failures carry their code. */
function projectObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = [...new Set(Object.keys(value))];
  if (value.supported !== true && value.supported !== false) throw projection();
  if (value.supported === false) {
    if (keys.length !== 5
      || !['host', 'password_present', 'skip_start', 'supported', 'username'].every(key => keys.includes(key))) {
      throw projection();
    }
    for (const key of ['skip_start', 'host', 'username']) {
      if (value[key] !== null) throw projection();
    }
    if (value.password_present !== null) throw projection();
    return { ...value };
  }
  if (keys.length !== 5 && keys.length !== 6) throw projection();
  if (!['host', 'password_present', 'skip_start', 'supported', 'username'].every(key => keys.includes(key))) {
    throw projection();
  }
  for (const key of ['skip_start', 'host', 'username']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length < 1
      || value[key].length > 256 || CONTROL.test(value[key]))) throw projection();
  }
  if (value.password_present !== true && value.password_present !== false && value.password_present !== null) {
    throw projection();
  }
  if (keys.length === 6 && (typeof value.error !== 'string' || value.error.length < 1
    || value.error.length > 64 || CONTROL.test(value.error))) throw projection();
  return { ...value };
}

/** Input-less verbs accept only an empty (or empty-object) body so stray state
 * can never ride an operator action. */
async function readEmptyBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_BYTES) throw new ContractError('request_too_large', 'compatibility-service action request exceeds its size bound');
    chunks.push(chunk);
  }
  if (size === 0) return;
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid(); }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.keys(parsed).length === 0) return;
  throw invalid();
}
