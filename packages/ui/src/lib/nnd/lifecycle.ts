// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA compatibility-service lifecycle contract (20261006-9).
 * The six census operator_action rows (status/start/stop/enable/disable/run) ride
 * the native surface at /v1/nnd/configuration/compatibility-service/actions whose
 * authority reuses src/opencode/service.js verbatim. status is a read action
 * (nnd.configuration.read) projecting the domain's redacted view — the password is
 * a presence flag and a source string, never a value — plus the runtime variant
 * grammar, the login wiring, and the presence-only OpenChamber environment
 * observation. start/stop/enable/disable are operator actions on the NEW
 * nnd.service.manage right (kept separate from the settings write right because
 * they reach outside the configuration file: a verified process kill, a
 * Startup-folder script, user-scope environment writes). Per-verb application
 * classes: status observes (not_applied); start reads the persisted wiring NOW
 * into a fresh runtime (start_service); stop is immediate (stop_service);
 * enable/disable flip the persisted flag and the login wiring whose wiring
 * surface takes effect at the next service start (next_service_start). run is
 * refused natively (nnd_service_run_unsupported: it is the foreground managed
 * runtime the detached start and the login startup script drive), so this client
 * exposes no composer for it and every other action takes no inputs at all. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/compatibility-service/actions';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[0-9a-f-]{36}$/u;
const ISO_CONTROLS = /[\x00-\x1f\x7f]/u;
// NNA binds responses to 65,536 bytes; the client keeps the same cap so a drifted
// projection refuses locally too.
export const SERVICE_LIFECYCLE_RESPONSE_BYTES = 65_536;
const RUNTIME_KEYS = ['running', 'pid', 'port', 'url', 'stale', 'verified', 'legacy', 'reason'];

export class NativeServiceLifecycleFailure extends Error { constructor(readonly code: string) { super(code); } }
const viewInvalid = () => new NativeServiceLifecycleFailure('nnd_service_view_invalid');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ServiceActionName = 'start' | 'stop' | 'enable' | 'disable';
export interface PublicServiceWire { autostart_enabled: boolean; configured: boolean;
  password_source: 'restricted local config' | 'environment' | null; username: string;
  hostname: string; port: number; bind_url: string }
export interface ServiceRuntimeView { running: boolean; verified?: boolean; pid?: number;
  legacy?: true; stale?: true; reason?: 'dead' | 'different'; port?: number; url?: string }
export interface ServiceLoginView { supported: boolean; installed: boolean | null;
  script_path: string | null; error?: string }
export interface ServiceEnvironmentObservation { supported: boolean; skip_start: string | null;
  host: string | null; password_present: boolean | null; username: string | null; error?: string }
export interface ServiceStatusView { service: PublicServiceWire; runtime: ServiceRuntimeView;
  login: ServiceLoginView; environment: ServiceEnvironmentObservation; stale_binding: boolean }
export interface ServiceStatusReceipt { schema_version: '1.0'; installation_id: string;
  data_id: string; scope: 'user'; action: 'status'; application: 'not_applied';
  operation_id: string; status: ServiceStatusView }
export interface StartReceipt { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; action: 'start'; application: 'start_service'; operation_id: string;
  started: boolean; reason: null | 'already_starting' | 'already_running'; pid: number | null;
  port: number | null; url: string | null; runtime: ServiceRuntimeView | null;
  environment: EnvironmentView }
export interface StopReceipt { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; action: 'stop'; application: 'stop_service'; operation_id: string;
  stopped: boolean; reason: null | 'not_running'; pid: number | null;
  environment: EnvironmentView }
export interface WiringReceipt { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; action: 'enable' | 'disable'; application: 'next_service_start';
  operation_id: string; service: PublicServiceWire; login: ServiceLoginView;
  runtime: ServiceRuntimeView }
export interface AppliedEnvironment { supported: true; written: readonly string[];
  removed: readonly string[]; unchanged: readonly string[] }
export type EnvironmentView = AppliedEnvironment | { supported: false } | null

const STATUS_KEYS = 'action,application,data_id,installation_id,operation_id,schema_version,scope,status';
const START_KEYS = 'action,application,data_id,environment,installation_id,operation_id,pid,port,reason,runtime,schema_version,scope,started,url';
const STOP_KEYS = 'action,application,data_id,environment,installation_id,operation_id,pid,reason,schema_version,scope,stopped';
const WIRING_KEYS = 'action,application,data_id,installation_id,login,operation_id,runtime,schema_version,scope,service';
const WIRE_KEYS = 'autostart_enabled,bind_url,configured,hostname,password_source,port,username';
const PASSWORD_SOURCES = ['restricted local config', 'environment'];
const NAMES = /^[A-Za-z0-9_]{1,64}$/u;

export async function readServiceStatus(signal: AbortSignal): Promise<ServiceStatusReceipt> {
  return parseServiceStatusReceipt(await call('status', 'GET', signal));
}
export async function requestServiceAction(action: ServiceActionName,
  signal: AbortSignal): Promise<StartReceipt | StopReceipt | WiringReceipt> {
  const payload = await call(action, 'POST', signal);
  if (action === 'start') return parseStartReceipt(payload);
  if (action === 'stop') return parseStopReceipt(payload);
  return parseWiringReceipt(payload);
}

export function parseServiceStatusReceipt(raw: unknown): ServiceStatusReceipt {
  const common = envelope(raw, STATUS_KEYS.split(','));
  if (common.action !== 'status' || (raw as Record<string, unknown>).application !== 'not_applied') throw viewInvalid();
  return { ...common, action: 'status', application: 'not_applied',
    status: parseStatusView((raw as Record<string, unknown>).status) } as ServiceStatusReceipt;
}

/** The runtime variant grammar mirrors the native projector exactly: every
 * variant carries only the keys the identity comparison produced. */
export function parseRuntimeView(value: unknown): ServiceRuntimeView {
  if (!record(value)) throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if ([...keys].some(key => !RUNTIME_KEYS.includes(key))) throw viewInvalid();
  if (value.running !== true && value.running !== false) throw viewInvalid();
  if (value.pid !== undefined && (typeof value.pid !== 'number'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0)) throw viewInvalid();
  if (value.url !== undefined && (typeof value.url !== 'string' || value.url.length < 1
    || value.url.length > 320 || ISO_CONTROLS.test(value.url))) throw viewInvalid();
  if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isSafeInteger(value.port)
    || value.port < 1 || value.port > 65_535)) throw viewInvalid();
  if (value.reason !== undefined && value.reason !== 'dead' && value.reason !== 'different') throw viewInvalid();
  if (value.stale !== undefined && value.stale !== true) throw viewInvalid();
  if (value.verified !== undefined && value.verified !== true && value.verified !== false) throw viewInvalid();
  if (value.legacy !== undefined && value.legacy !== true) throw viewInvalid();
  if (value.running === true) {
    if (keys.has('reason') || keys.has('stale') || value.verified === undefined) throw viewInvalid();
    if (value.legacy !== undefined && value.verified !== false) throw viewInvalid();
    return { ...value } as unknown as ServiceRuntimeView;
  }
  if (keys.has('verified') || keys.has('legacy') || keys.has('port') || keys.has('url')) throw viewInvalid();
  if (keys.has('reason') && value.stale !== true) throw viewInvalid();
  return { ...value } as unknown as ServiceRuntimeView;
}

function parseStatusView(value: unknown): ServiceStatusView {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'environment,login,runtime,service,stale_binding'
    || (value.stale_binding !== true && value.stale_binding !== false)) throw viewInvalid();
  return { service: parseWire(value.service as Record<string, unknown>),
    runtime: parseRuntimeView(value.runtime), login: parseLogin(value.login),
    environment: parseObservation(value.environment), stale_binding: value.stale_binding };
}

function parseWire(value: unknown): PublicServiceWire {
  if (!record(value) || Object.keys(value).sort().join(',') !== WIRE_KEYS
    || (value.autostart_enabled !== true && value.autostart_enabled !== false)
    || (value.configured !== true && value.configured !== false)) throw viewInvalid();
  if (value.password_source !== null && (typeof value.password_source !== 'string'
    || !PASSWORD_SOURCES.includes(value.password_source))) throw viewInvalid();
  if (typeof value.username !== 'string' || value.username.length < 1 || value.username.length > 64
    || ISO_CONTROLS.test(value.username)) throw viewInvalid();
  if (typeof value.hostname !== 'string' || value.hostname.length < 1 || value.hostname.length > 253
    || ISO_CONTROLS.test(value.hostname)) throw viewInvalid();
  if (typeof value.port !== 'number' || !Number.isSafeInteger(value.port)
    || value.port < 1 || value.port > 65_535) throw viewInvalid();
  if (typeof value.bind_url !== 'string' || value.bind_url.length < 1 || value.bind_url.length > 320
    || ISO_CONTROLS.test(value.bind_url) || !value.bind_url.startsWith('http://')
    || !value.bind_url.endsWith(`:${value.port}`)) throw viewInvalid();
  return { ...value } as unknown as PublicServiceWire;}

function parseLogin(value: unknown): ServiceLoginView {
  if (!record(value) || typeof value.supported !== 'boolean') throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (keys.size > 4 || [...keys].some(key => !['installed', 'script_path', 'supported', 'error'].includes(key))) {
    throw viewInvalid();
  }
  if (value.installed !== null && value.installed !== true && value.installed !== false) throw viewInvalid();
  if (value.script_path !== undefined && value.script_path !== null
    && (typeof value.script_path !== 'string' || value.script_path.length < 1
      || value.script_path.length > 1024 || ISO_CONTROLS.test(value.script_path))) throw viewInvalid();
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1
    || value.error.length > 64 || ISO_CONTROLS.test(value.error))) throw viewInvalid();
  if (value.error !== undefined && !(value.supported === true && value.installed === null)) throw viewInvalid();
  if (value.error === undefined && value.supported === true && value.installed === null) throw viewInvalid();
  return { supported: value.supported, installed: value.installed,
    script_path: value.script_path ?? null, ...(value.error === undefined ? {} : { error: value.error }) } as ServiceLoginView;
}

export function parseAppliedEnvironment(value: unknown): EnvironmentView {
  if (value === null || value === undefined) return null;
  if (!record(value)) throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (value.supported === false) {
    if (keys.size !== 1) throw viewInvalid();
    return { supported: false } as EnvironmentView;
  }
  if (value.supported !== true || (keys.size !== 3 && keys.size !== 4)) throw viewInvalid();
  if (keys.size === 3 && Array.isArray(value.written) && value.written.length !== 0) throw viewInvalid();
  const listKeys = keys.size === 4 ? ['written', 'removed', 'unchanged'] : ['written', 'removed'];
  for (const key of listKeys) {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 4
      || list.some(name => typeof name !== 'string' || !NAMES.test(name))) throw viewInvalid();
  }
  return keys.size === 4
    ? { supported: true, written: [...value.written as string[]], removed: [...value.removed as string[]],
        unchanged: [...value.unchanged as string[]] }
    : { supported: true, written: [...value.written as string[]], removed: [...value.removed as string[]],
        unchanged: [] };
}

function parseObservation(value: unknown): ServiceEnvironmentObservation {
  if (!record(value)) throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (value.supported !== true && value.supported !== false) throw viewInvalid();
  if (value.supported === false) {
    if (keys.size !== 5
      || !['host', 'password_present', 'skip_start', 'supported', 'username'].every(key => keys.has(key))) throw viewInvalid();
    for (const key of ['skip_start', 'host', 'username']) if (value[key] !== null) throw viewInvalid();
    if (value.password_present !== null) throw viewInvalid();
    return { ...value } as unknown as ServiceEnvironmentObservation;
  }
  if (keys.size !== 5 && keys.size !== 6) throw viewInvalid();
  if (!['host', 'password_present', 'skip_start', 'supported', 'username'].every(key => keys.has(key))) throw viewInvalid();
  for (const key of ['skip_start', 'host', 'username']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length < 1
      || value[key].length > 256 || ISO_CONTROLS.test(value[key]))) throw viewInvalid();
  }
  if (value.password_present !== true && value.password_present !== false && value.password_present !== null) throw viewInvalid();
  if (keys.size === 6 && (typeof value.error !== 'string' || value.error.length < 1
    || value.error.length > 64 || ISO_CONTROLS.test(value.error))) throw viewInvalid();
  return { ...value } as unknown as ServiceEnvironmentObservation;
}

export function parseStartReceipt(raw: unknown): StartReceipt {
  const common = envelope(raw, START_KEYS.split(','));
  const value = raw as Record<string, unknown>;
  if (common.action !== 'start' || value.application !== 'start_service') throw viewInvalid();
  if (value.started !== true && value.started !== false) throw viewInvalid();
  if (value.started === true) {
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.port !== 'number' || !Number.isSafeInteger(value.port)
      || value.port < 1 || value.port > 65_535 || typeof value.url !== 'string'
      || value.url.length < 1 || value.url.length > 320 || ISO_CONTROLS.test(value.url)
      || value.reason !== null || value.runtime !== null) throw viewInvalid();
    return { ...common, action: 'start', application: 'start_service', started: true, reason: null,
      pid: value.pid, port: value.port, url: value.url, runtime: null,
      environment: parseAppliedEnvironment(value.environment) } as StartReceipt;
  }
  if (value.reason !== 'already_starting' && value.reason !== 'already_running') throw viewInvalid();
  return { ...common, action: 'start', application: 'start_service', started: false,
    reason: value.reason as StartReceipt['reason'], pid: null, port: null, url: null,
    runtime: parseRuntimeView(value.runtime),
    environment: parseAppliedEnvironment(value.environment) } as StartReceipt;
}

export function parseStopReceipt(raw: unknown): StopReceipt {
  const common = envelope(raw, STOP_KEYS.split(','));
  const value = raw as Record<string, unknown>;
  if (common.action !== 'stop' || value.application !== 'stop_service') throw viewInvalid();
  if (value.stopped !== true && value.stopped !== false) throw viewInvalid();
  if (value.stopped === true) {
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || value.reason !== null) throw viewInvalid();
    return { ...common, action: 'stop', application: 'stop_service', stopped: true, reason: null,
      pid: value.pid,
      environment: parseAppliedEnvironment(value.environment) } as StopReceipt;
  }
  if (value.reason !== 'not_running' || value.pid !== null) throw viewInvalid();
  return { ...common, action: 'stop', application: 'stop_service', stopped: false,
    reason: 'not_running', pid: null,
    environment: parseAppliedEnvironment(value.environment) } as StopReceipt;
}

export function parseWiringReceipt(raw: unknown): WiringReceipt {
  const common = envelope(raw, WIRING_KEYS.split(','));
  const value = raw as Record<string, unknown>;
  if (common.action !== 'enable' && common.action !== 'disable') throw viewInvalid();
  if (value.application !== 'next_service_start') throw viewInvalid();
  return { ...common, action: common.action as 'enable' | 'disable', application: 'next_service_start',
    service: parseWire(value.service), login: parseLogin(value.login),
    runtime: parseRuntimeView(value.runtime) } as WiringReceipt;
}

function envelope(raw: unknown, legalKeys: readonly string[]): {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  action: string; application: string; operation_id: string } {
  if (!record(raw)) throw viewInvalid();
  const keys = new Set(Object.keys(raw));
  if (keys.size !== legalKeys.length
    || [...keys].some(key => !legalKeys.includes(key))) throw viewInvalid();
  if (raw.schema_version !== '1.0' || raw.scope !== 'user') throw viewInvalid();
  if (typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id)
    || typeof raw.action !== 'string' || typeof raw.application !== 'string'
    || typeof raw.operation_id !== 'string' || !OPERATION_ID.test(raw.operation_id)) throw viewInvalid();
  return raw as { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
    action: string; application: string; operation_id: string };
}

async function call(action: string, method: 'GET' | 'POST', signal: AbortSignal): Promise<unknown> {
  const response = await runtimeFetch(`${BASE}/${action}`, { method,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  const payload = await boundedJson(response, SERVICE_LIFECYCLE_RESPONSE_BYTES);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = typeof error?.code === 'string' ? error.code
      : response.status === 404 ? 'nnd_service_action_unsupported' : 'nnd_service_unavailable';
    throw new NativeServiceLifecycleFailure(code);
  }
  return payload;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw viewInvalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > bounds) { await reader.cancel(); throw viewInvalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw viewInvalid(); }
}

export function serviceLifecycleErrorText(code: string): string {
  if (code === 'nnd_service_action_unsupported') return 'This NNA does not expose compatibility-service actions.';
  if (code === 'nnd_service_unavailable') return 'Compatibility-service actions are unavailable.';
  if (code === 'nnd_service_run_unsupported') return 'The managed runtime runs through start or the login startup script, not this surface.';
  if (code === 'opencode_login_wiring_unsupported') return 'Login wiring and the OpenChamber environment are Windows-only on this NNA.';
  if (code === 'opencode_service_unauthenticated') return 'Start the surface after wiring credentials natively; it never runs unauthenticated.';
  if (code === 'opencode_identity_unverifiable') return 'The surface refuses to stop a runtime whose identity cannot be verified; reconcile it natively first.';
  if (code === 'opencode_start_failed') return 'The managed runtime exited during its start; inspect opencode-console.log natively.';
  if (code === 'opencode_identity_unavailable') return 'The runtime could not be identified natively.';
  if (code === 'opencode_startup_folder_unavailable' || code === 'opencode_startup_folder_empty'
    || code === 'opencode_login_wiring_probe_failed') return 'The Windows Startup wiring could not be reached; reconcile it natively.';
  if (code === 'opencode_user_environment_failed' || code === 'opencode_user_environment_probe_failed') {
    return 'The OpenChamber user environment could not be wired; reconcile it natively.';
  }
  if (code === 'opencode_config_invalid' || code === 'opencode_config_version_unsupported'
    || code === 'opencode_config_too_large' || code === 'opencode_bind_port_invalid'
    || code === 'opencode_hostname_invalid' || code === 'opencode_password_invalid'
    || code === 'opencode_username_invalid' || code === 'opencode_bind_exposed_requires_password') {
    return 'The persisted wiring configuration needs native repair before lifecycle actions can run.';
  }
  if (code === 'nnd_service_action_invalid') return 'The action request was refused natively.';
  if (code === 'nnd_service_view_invalid') return 'The refused projection failed its sentence check instead.';
  return 'The compatibility-service action could not be completed.';
}
