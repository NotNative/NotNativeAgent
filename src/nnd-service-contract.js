// SPDX-License-Identifier: Apache-2.0
// Compatibility: this schema describes future service activation, not runtime capability availability.
export const NND_SERVICE_PROTOCOL = '1.0';
export const NND_SERVICE_READY_MESSAGE_TYPE = 'ready';
export const NND_SERVICE_STATES = Object.freeze([
  'absent', 'incompatible', 'starting', 'ready', 'degraded', 'stopping', 'stopped', 'failed', 'setup_required',
]);
export const NND_SETUP_REQUIRED_STATE = 'setup_required';
export const NND_EXECUTION_GUARDED_STATES = Object.freeze(NND_SERVICE_STATES.filter((state) => state !== 'ready'));
export const NND_SERVICE_COMMANDS = Object.freeze(['start', 'stop', 'status', 'restart']);
export const STABLE_NND_FAILURE_CODES = Object.freeze({
  MANIFEST_INVALID: 'nnd_package_manifest_invalid', PACKAGE_INCOMPATIBLE: 'nnd_package_incompatible',
  PACKAGE_NOT_REGISTERED: 'nnd_package_not_active', CONFIG_INVALID: 'nnd_config_invalid',
  SETUP_REQUIRED: 'nnd_setup_required', SERVICE_ALREADY_RUNNING: 'nnd_service_already_running',
  SERVICE_NOT_RUNNING: 'nnd_service_not_running', LOCK_ACQUIRE_FAILED: 'nnd_lock_acquire_failed',
  LOCK_LOST: 'nnd_lock_lost', OWNER_UNVERIFIED: 'nnd_owner_unverified', PORT_COLLISION: 'nnd_port_collision',
  START_TIMEOUT: 'nnd_start_timeout', STOP_TIMEOUT: 'nnd_stop_timeout', SERVICE_CRASHED: 'nnd_service_crashed',
  HEALTH_UNAVAILABLE: 'nnd_health_unavailable', REGISTRY_VERSION_MISMATCH: 'nnd_registry_version_mismatch',
});
export const NND_SERVICE_STATUS_KEYS = Object.freeze([
  'service_state', 'failure_code', 'installation_id', 'data_id', 'instance_id', 'endpoint',
  'package_version', 'protocol', 'runtime_state', 'package_state', 'provider_state', 'setup_guidance',
]);
const VERSION = /^\d{8}-[1-9]\d{0,5}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
export function isKnownNndServiceState(state) { return NND_SERVICE_STATES.includes(state); }
// Security: unknown lifecycle values cannot open execution admission.
export function isExecutionGuarded(state) { return state !== 'ready'; }
export function exactRecord(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function isNndVersion(value) { return typeof value === 'string' && VERSION.test(value); }
function loopbackEndpoint(value) {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      && value === url.origin && Number(url.port) > 0;
  } catch { return false; }
}
function requireStatus(condition, message) {
  if (!condition) throw new TypeError(`Invalid NND service status: ${message}`);
}
function assertReadiness(value) {
  requireStatus(['unavailable', 'starting', 'ready', 'failed'].includes(value.runtime_state), 'runtime_state');
  requireStatus(['absent', 'incompatible', 'ready'].includes(value.package_state), 'package_state');
  requireStatus(['unknown', 'setup_required', 'ready', 'unavailable'].includes(value.provider_state), 'provider_state');
  const live = ['ready', 'setup_required', 'degraded'].includes(value.service_state);
  requireStatus(live ? loopbackEndpoint(value.endpoint) : value.endpoint === null, 'endpoint readiness');
  if (live) requireStatus(value.runtime_state === 'ready' && value.package_state === 'ready'
    && value.instance_id !== null && value.package_version !== null, 'live prerequisites');
  if (value.service_state === 'ready') requireStatus(value.provider_state === 'ready'
    && value.failure_code === null && value.setup_guidance === null, 'ready prerequisites');
  if (value.service_state === 'setup_required') requireStatus(value.provider_state === 'setup_required'
    && value.failure_code === STABLE_NND_FAILURE_CODES.SETUP_REQUIRED, 'setup prerequisites');
  if (value.service_state === 'absent') requireStatus(value.package_state === 'absent'
    && value.package_version === null, 'absent package');
  if (value.service_state === 'incompatible') requireStatus(value.package_state === 'incompatible', 'incompatible package');
  if (['absent', 'incompatible', 'setup_required', 'failed', 'degraded'].includes(value.service_state)) {
    requireStatus(value.failure_code !== null && value.setup_guidance !== null, 'failure guidance');
  }
}
export function assertStatusEnvelope(value) {
  requireStatus(exactRecord(value, NND_SERVICE_STATUS_KEYS), 'key set');
  requireStatus(isKnownNndServiceState(value.service_state), 'service_state');
  requireStatus(value.protocol === NND_SERVICE_PROTOCOL, 'protocol');
  requireStatus(value.failure_code === null || Object.values(STABLE_NND_FAILURE_CODES).includes(value.failure_code), 'failure_code');
  for (const key of ['installation_id', 'data_id', 'instance_id']) {
    requireStatus((key === 'instance_id' && value[key] === null)
      || (typeof value[key] === 'string' && ID.test(value[key])), key);
  }
  requireStatus(value.package_version === null || isNndVersion(value.package_version), 'package_version');
  requireStatus(value.setup_guidance === null || (typeof value.setup_guidance === 'string'
    && value.setup_guidance.trim().length > 0 && value.setup_guidance.length <= 1024
    && !/[\u0000-\u001f\u007f]/u.test(value.setup_guidance)), 'setup_guidance');
  assertReadiness(value);
  return value;
}
