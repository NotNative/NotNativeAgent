// SPDX-License-Identifier: Apache-2.0
/** Native environment observation route over /v1/nnd/configuration/environment.
 * Why: the seven census environment rows need the authenticated native read surface
 * the settings families established, backed by the live service-process observation.
 * Invariant: read-only (GET with the read permission only), fail-closed projector that
 * whitelists every response key, credential entries always project presence without a
 * value, and the response is bounded (the projector refuses oversize values upstream).
 * Compatibility: no legacy request shape exists for this family.
 */
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { OBSERVED_NAMES, SECRET_NAMES } from './nnd-environment-snapshot.js';

const BASE = '/v1/nnd/configuration/environment';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const NAME = /^[A-Z0-9_]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const invalid = () => new ContractError('nnd_environment_request_invalid', 'Native environment request is invalid.');

// Read-only family: every field is observable state, nothing is editable here — the
// environment is changed in the Windows shell and reaches the service at restart.
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'environment', scope: 'user',
  fields: Object.freeze(OBSERVED_NAMES.map((name) => Object.freeze({
    path: name,
    classification: SECRET_NAMES.has(name) ? 'operator_credential' : 'operator_setting',
    application: 'restart_service',
    editability: { available: false, scope: 'user', reason: 'process_environment' },
  }))) });

export async function dispatchNndEnvironmentRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  // Permission first, exactly like the sibling family routes: a lesser token does not
  // learn service availability from method or state distinctions.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return send(response, 200, CATALOG);
  }
  if (path !== BASE) return send(response, 404, { error: 'not_found' });
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndEnvironmentSnapshotService;
  if (!service || typeof service.read !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native environment observation is unavailable.');
  }
  const value = await service.read(context.principal);
  const projected = projectView(value);
  // The bound cannot hold legal state-derived payload: one public value is refused
  // above 16,384 UTF-8 bytes, whose longest JSON escaping is 6 bytes per source byte
  // (98,304), and five entries carry public values (491,520) plus fixed names, the
  // digest, and overhead. Exceeding it means projector drift, not a legal read.
  if (Buffer.byteLength(JSON.stringify(projected)) > 524288) throw invalid();
  return send(response, 200, projected);
}

function projectView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== '1.0'
    || typeof value.installation_id !== 'string' || !ID.test(value.installation_id)
    || typeof value.data_id !== 'string' || !ID.test(value.data_id) || value.scope !== 'user'
    || typeof value.observation_digest !== 'string' || !DIGEST.test(value.observation_digest)
    || value.environment_scope !== 'service_process'
    || !Array.isArray(value.observed) || value.observed.length !== OBSERVED_NAMES.length) throw invalid();
  const seen = new Set();
  const observed = value.observed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'name,present,secret,value'
      || typeof entry.name !== 'string' || !NAME.test(entry.name) || !OBSERVED_NAMES.includes(entry.name)
      || (entry.present !== true && entry.present !== false)
      || (entry.secret !== true && entry.secret !== false)) throw invalid();
    if (SECRET_NAMES.has(entry.name) && (entry.secret !== true || entry.present && entry.value !== null)) throw invalid();
    if (entry.present === false && entry.value !== null) throw invalid();
    if (entry.present === true && !SECRET_NAMES.has(entry.name) && typeof entry.value !== 'string') throw invalid();
    seen.add(entry.name);
    return Object.freeze({ name: entry.name, secret: entry.secret, present: entry.present,
      value: typeof entry.value === 'string' ? entry.value : null });
  });
  if (seen.size !== OBSERVED_NAMES.length
    || observed.some((entry, at) => entry.name !== OBSERVED_NAMES[at])) throw invalid();
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id, scope: 'user',
    observation_digest: value.observation_digest, observed, environment_scope: 'service_process' };
}
