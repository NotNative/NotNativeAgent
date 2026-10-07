// SPDX-License-Identifier: Apache-2.0
/** Native installation-identity observation route over
 * /v1/nnd/configuration/installation. Why: the six census installation rows
 * classify the install.json descriptor (product, version, install_root,
 * data_root, node, node_major), and this surface reads it back from the
 * descriptor the service was admitted with, re-verified on disk by the
 * authority behind every read. Invariant: read-only (GET with the read
 * permission only), fail-closed projector that whitelists every response
 * key, and the response is bounded. A drifted or missing descriptor is the
 * trust-validating projection failing closed: the listener must not project
 * an admission the disk no longer supports (the -3 environment-route
 * stance), so the read refuses with the descriptor authority's own
 * nnd_install_* codes and the operator repairs the installation.
 * Transport envelope overshoot stops before validation with
 * request_too_large (400); the semantic check refuses with
 * nnd_installation_request_invalid and projector drift with
 * nnd_installation_projection_invalid.
 */
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { OBSERVED_DESCRIPTOR } from './nnd-installation-snapshot.js';

const BASE = '/v1/nnd/configuration/installation';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PRODUCT = 'NotNativeAgent';
const VERSION = /^\d{8}-[1-9]\d{0,5}$/u;
const PATH = /^[^\u0000-\u001f]{1,4096}$/u;
const invalid = () => new ContractError('nnd_installation_request_invalid', 'Native installation request is invalid.');
const projection = () => new ContractError('nnd_installation_projection_invalid', 'Native installation observation refused a drifted projected view.');

// Read-only family: the descriptor is written by the product installer; a
// running service never rewrites its own admission.
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'installation', scope: 'user',
  fields: Object.freeze(OBSERVED_DESCRIPTOR.map((name) => Object.freeze({
    path: name,
    classification: 'generated_state',
    application: 'not_applied',
    editability: { available: false, scope: 'user', reason: 'installer_state' },
  }))) });

export async function dispatchNndInstallationRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  // Permission first, exactly like the sibling family routes: a lesser token
  // does not learn service availability from method or state distinctions.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return send(response, 200, CATALOG);
  }
  if (path !== BASE) return send(response, 404, { error: 'not_found' });
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndInstallationSnapshotService;
  if (!service || typeof service.read !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native installation observation is unavailable.');
  }
  const value = await service.read(context.principal);
  const projected = projectView(value);
  // The bound cannot hold legal valued state: the three paths are bounded at
  // 4096 UTF-8 units each (worst 6-byte JSON escaping per unit is ~24,576
  // bytes each), plus product/VERSION and fixed keys far below 1 KiB.
  // Anything over that is projector drift, not a legal read.
  if (Buffer.byteLength(JSON.stringify(projected)) > 73_728) throw invalid();
  return send(response, 200, projected);
}

function projectView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== '1.0'
    || typeof value.installation_id !== 'string' || !ID.test(value.installation_id)
    || typeof value.data_id !== 'string' || !ID.test(value.data_id) || value.scope !== 'user'
    || value.product !== PRODUCT || typeof value.version !== 'string' || !VERSION.test(value.version)
    || typeof value.install_root !== 'string' || !PATH.test(value.install_root)
    || typeof value.data_root !== 'string' || !PATH.test(value.data_root)
    || typeof value.node !== 'string' || !PATH.test(value.node)
    || !Number.isSafeInteger(value.node_major) || value.node_major < 24 || value.node_major > 100) throw projection();
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', product: value.product, version: value.version,
    install_root: value.install_root, data_root: value.data_root,
    node: value.node, node_major: value.node_major };
}
