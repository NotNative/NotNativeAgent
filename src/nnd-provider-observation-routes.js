// SPDX-License-Identifier: Apache-2.0
/** Native provider-observation route over
 * /v1/nnd/configuration/provider-observations. Why: the thirteen census
 * manifest_provider rows (credential binding source/name/secret_id/field, the
 * credential container, the credential_env compatibility alias, and the
 * capability flags, each in both the providers[*] and provider spellings) had no
 * native endpoint at all, so no desktop surface could show which credential a
 * provider is bound to without reading the manifest by hand.
 * Invariant: read-only (GET with nnd.configuration.read), a fail-closed projector
 * that whitelists every response key, and a bound response. Secret VALUES are
 * unreachable here by construction: the binding arrives already projected by
 * credentialManifest, which yields source plus name, or source plus secret id
 * and field, and the projector refuses anything else. Provider mutation is not
 * this surface's to own; it belongs to the manifest transaction that writes with
 * an expected revision, so every catalog field reports itself unavailable for
 * editing with that reason.
 * Envelope overshoot refuses with nnd_provider_observation_request_invalid (400),
 * as does a query string; a service that is not wired refuses with
 * nnd_configuration_unavailable; projector drift refuses with
 * nnd_provider_observation_projection_invalid.
 */
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const BASE = '/v1/nnd/configuration/provider-observations';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(absent|[a-f0-9]{64})$/u;
const NAME = /^[A-Za-z0-9_]{1,256}$/u;
const TEXT = /^[^\u0000-\u001f]{1,256}$/u;
// The same three words config.js admits (TRUST_ZONES there, unexported); a zone
// this route has never heard of is drift, not a new kind of provider.
const TRUST_ZONES = new Set(['loopback', 'private_network', 'public_network']);
const PATHS = Object.freeze(['providers[*].credential', 'providers[*].credential.source',
  'providers[*].credential.name', 'providers[*].credential.secret_id', 'providers[*].credential.field',
  'providers[*].capabilities', 'provider.credential', 'provider.credential_env', 'provider.capabilities',
  'provider.credential.source', 'provider.credential.name', 'provider.credential.secret_id',
  'provider.credential.field']);
const invalid = () => new ContractError('nnd_provider_observation_request_invalid',
  'Native provider observation request is invalid.');
const projection = () => new ContractError('nnd_provider_observation_projection_invalid',
  'Native provider observation refused a drifted projected view.');

// Classification, intent and sensitivity are taken from NNA's own catalog
// metadata for these exact fields (configuration-catalog-metadata.js: credential
// and capabilities are containers, credential_env is the compatibility alias,
// the binding leaves are operator settings with credential_reference
// sensitivity); nothing here is a word this route made up.
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'manifest_provider', scope: 'user',
  fields: Object.freeze(PATHS.map((path) => Object.freeze({
    path,
    classification: path.endsWith('.credential') || path.endsWith('.capabilities') ? 'container'
      : path.endsWith('credential_env') ? 'compatibility_alias' : 'operator_setting',
    // The capability flags are not a binding, so only the credential paths
    // carry the binding intent and reference sensitivity NNA gives them.
    ...(path.includes('credential') ? { intent: 'credential_binding', sensitivity: 'credential_reference' }
      : {}),
    application: 'not_applied',
    editability: { available: false, scope: 'user', reason: 'manifest_transaction_owns_writes' },
  }))) });

export async function dispatchNndProviderObservationRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  // Permission first, like every sibling family route: a lesser token must not
  // learn whether the service is wired from a method or state distinction.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return send(response, 200, CATALOG);
  }
  if (path !== BASE) return send(response, 404, { error: 'not_found' });
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndProviderObservationService;
  if (!service || typeof service.read !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native provider observation is unavailable.');
  }
  const projected = projectView(await service.read(context.principal));
  // Bounded: at most 32 profiles, each with a model/endpoint under 256 units and
  // a binding of at most three short strings; 73,728 bytes cannot be reached by
  // legal state, so overshoot is drift rather than a wide read.
  if (Buffer.byteLength(JSON.stringify(projected)) > 73_728) throw invalid();
  return send(response, 200, projected);
}

function projectBinding(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = new Set(Object.keys(value));
  if (value.source === 'environment') {
    if (keys.size !== 2 || typeof value.name !== 'string' || !NAME.test(value.name)) throw projection();
    return { source: 'environment', name: value.name };
  }
  if (value.source === 'secret') {
    if (keys.size !== 3 || typeof value.secret_id !== 'string' || !ID.test(value.secret_id)
      || typeof value.field !== 'string' || !NAME.test(value.field)) throw projection();
    return { source: 'secret', secret_id: value.secret_id, field: value.field };
  }
  throw projection();
}

function projectCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const names = ['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation'];
  if (new Set(Object.keys(value)).size !== names.length) throw projection();
  const flags = {};
  for (const name of names) {
    if (typeof value[name] !== 'boolean') throw projection();
    flags[name] = value[name];
  }
  return flags;
}

function projectCredentialEnv(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !NAME.test(value)) throw projection();
  return value;
}

function projectView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== '1.0'
    || typeof value.installation_id !== 'string' || !ID.test(value.installation_id)
    || typeof value.data_id !== 'string' || !ID.test(value.data_id) || value.scope !== 'user'
    || !['absent', 'present'].includes(value.source_state)
    || typeof value.manifest_revision !== 'string' || !REVISION.test(value.manifest_revision)
    || !Array.isArray(value.providers)) throw projection();
  if (new Set(Object.keys(value)).size !== 7) throw projection();
  const providers = value.providers.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw projection();
    if (new Set(Object.keys(entry)).size !== 7) throw projection();
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) throw projection();
    if (typeof entry.model !== 'string' || !TEXT.test(entry.model)) throw projection();
    if (typeof entry.endpoint !== 'string' || !TEXT.test(entry.endpoint)) throw projection();
    if (!TRUST_ZONES.has(entry.trust_zone)) throw projection();
    return { id: entry.id, model: entry.model, endpoint: entry.endpoint, trust_zone: entry.trust_zone,
      credential: projectBinding(entry.credential), credential_env: projectCredentialEnv(entry.credential_env),
      capabilities: projectCapabilities(entry.capabilities) };
  });
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', source_state: value.source_state, manifest_revision: value.manifest_revision,
    providers };
}
