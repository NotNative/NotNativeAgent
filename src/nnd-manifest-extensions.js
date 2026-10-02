// SPDX-License-Identifier: Apache-2.0
// Compatibility: legacy package registration does not require service activation metadata.
import { ContractError } from './ids.js';
import { exactRecord, isNndVersion, NND_SERVICE_PROTOCOL } from './nnd-service-contract.js';

export const NND_REQUIRED_SERVICE_CAPABILITIES = Object.freeze(['service_supervision', 'setup_control_plane']);
export const NND_ACTIVATION_KEYS = Object.freeze([
  'schema_version', 'required_capabilities', 'data_schemas', 'platform', 'architecture',
  'runtime', 'entrypoint', 'bundle_identity', 'authenticated_callbacks',
]);
const SCHEMA_KEYS = ['nnd_catalog', 'nnd_state'];
const CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/u;
function relativeModule(value) {
  return typeof value === 'string' && value.length <= 240 && value.endsWith('.mjs')
    && value.split('/').every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(part));
}
function capabilities(value) {
  return Array.isArray(value) && value.length <= 32 && value.every((entry) => typeof entry === 'string'
    && CAPABILITY.test(entry)) && new Set(value).size === value.length
    && NND_REQUIRED_SERVICE_CAPABILITIES.every((entry) => value.includes(entry));
}
export function validateNndManifestAdditions(manifest) {
  const value = manifest?.service_activation;
  if (!exactRecord(value, NND_ACTIVATION_KEYS)) return ['service_activation key set is invalid'];
  const problems = [];
  if (value.schema_version !== '1.0') problems.push('unsupported activation schema');
  if (!capabilities(value.required_capabilities)) problems.push('required capabilities are invalid');
  if (!exactRecord(value.data_schemas, SCHEMA_KEYS)
    || SCHEMA_KEYS.some((key) => value.data_schemas[key] !== 1)) problems.push('unsupported data schema');
  if (value.platform !== 'win32' || !['x64', 'arm64'].includes(value.architecture)) problems.push('unsupported platform or architecture');
  if (!exactRecord(value.runtime, ['name', 'minimum_major']) || value.runtime.name !== 'node'
    || !Number.isSafeInteger(value.runtime.minimum_major) || value.runtime.minimum_major < 24
    || value.runtime.minimum_major > 100) problems.push('invalid Node runtime requirement');
  if (!relativeModule(value.entrypoint)) problems.push('invalid entrypoint');
  if (!exactRecord(value.bundle_identity, ['path', 'sha256']) || !relativeModule(value.bundle_identity.path)
    || typeof value.bundle_identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundle_identity.sha256)) {
    problems.push('invalid bundle identity');
  }
  if (!exactRecord(value.authenticated_callbacks, ['token_exchange', 'protocol'])
    || value.authenticated_callbacks.token_exchange !== 'protected_stdin'
    || value.authenticated_callbacks.protocol !== NND_SERVICE_PROTOCOL) problems.push('unsupported authenticated callback');
  return problems;
}
export function validateNndManifestExtensions(manifest) {
  if (!manifest || manifest.id !== 'nnd-local' || manifest.ownership !== 'nnd' || manifest.scope !== 'local-gui'
    || manifest.nna_integration_protocol !== NND_SERVICE_PROTOCOL || !isNndVersion(manifest.version)) {
    throw new ContractError('nnd_package_manifest_invalid', 'NND package identity, protocol, or version is invalid');
  }
  const problems = validateNndManifestAdditions(manifest);
  if (problems.length) throw new ContractError('nnd_package_manifest_invalid', problems.join('; '));
  return manifest;
}
// Security: schema validity does not assert implementation. Callers supply capabilities observed from the host.
export function assertNndActivationCompatibility(manifest, host) {
  validateNndManifestExtensions(manifest);
  const value = manifest.service_activation;
  const validHost = exactRecord(host, ['platform', 'architecture', 'node_major', 'capabilities', 'data_schemas'])
    && Array.isArray(host.capabilities) && host.capabilities.length <= 32
    && host.capabilities.every((entry) => typeof entry === 'string' && CAPABILITY.test(entry))
    && exactRecord(host.data_schemas, SCHEMA_KEYS) && Number.isSafeInteger(host.node_major);
  if (!validHost || host.platform !== value.platform || host.architecture !== value.architecture
    || host.node_major < value.runtime.minimum_major
    || value.required_capabilities.some((name) => !host.capabilities.includes(name))
    || SCHEMA_KEYS.some((key) => host.data_schemas[key] !== value.data_schemas[key])) {
    throw new ContractError('nnd_package_incompatible', 'NNA host does not satisfy NND activation requirements');
  }
  return manifest;
}
