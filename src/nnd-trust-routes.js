// SPDX-License-Identifier: Apache-2.0
/** Native trusted-workspaces settings surface over /v1/nnd/configuration/trust.
 * Why: the census classifies config/trusted-workspaces.json as three trust rows —
 * the canonical workspace grants that govern admission of project configuration and
 * skills. This surface lists them, exposes the catalog, and operates grant/revoke
 * THROUGH the native trust functions (src/experience/trust.js) so admission
 * semantics, canonicalization, locking, and atomics stay native.
 * Invariant: a corrupt or unreadable store MUST NOT project as an empty list —
 * "nothing trusted" would admit unsafe flows — so the reader surfaces
 * workspace_trust_invalid honestly (503) and callers re-try after repair. Transport
 * envelope overshoot stops before validation with request_too_large (400); the
 * semantic root check refuses with nnd_trust_request_invalid.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { listTrust, trustWorkspace, untrustWorkspace } from './experience/trust.js';

const BASE = '/v1/nnd/configuration/trust';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
// Transport bound only: mirrors the native realpath input space (32,767 UTF-16 units
// plus one), not a semantic path cap; the native canonicalization and realpath decide
// whether a root exists. The request envelope takes the same cap four-fold because a
// fully escaped JSON string can cost 4 bytes per unit.
const ROOT_MAX = 32_768;
const REQUEST_BYTES = 131_072;
const CENSUS_FIELDS = Object.freeze(['version', 'workspaces[*].root', 'workspaces[*].trustedAt']);
// Loose ceiling, not a derived bound: a legal store then projects at roughly its own
// byte size (JSON keys re-escape at most 1:1, probe worst 262k → ~310k with fixed
// keys and envelope), so anything beyond this is projector drift and fails closed.
const RESPONSE_BOUND = 2_097_152 + 65_536;
// Receipt ceiling over the largest legal canonical root (32,767 units, ≤2 bytes per
// unit escaping) plus the fixed envelope. A receipt refusal here must be impossible
// for any path realpath can return, because the grant has already applied.
const RECEIPT_BOUND = 131_072;
const invalid = () => new ContractError('nnd_trust_request_invalid', 'Native trust request is invalid.');

const EDITABLE = 'nnd.workspace.manage';
const field = (path, definition) => Object.freeze({ path, classification: 'authority_grant',
  application: 'project_configuration', scope: 'user', ...definition });
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'trust', scope: 'user',
  fields: Object.freeze([
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
    field('workspaces[*].root', { operations: ['grant', 'revoke'], required_permission: EDITABLE,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('workspaces[*].trustedAt', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export async function dispatchNndTrustRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const mutating = path === `${BASE}/grant` || path === `${BASE}/revoke`;
  const action = path === BASE ? 'list' : path === `${BASE}/catalog` ? 'catalog'
    : mutating ? path.slice(BASE.length + 1) : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  // Permission first, exactly like the sibling family routes; mutations need both the
  // settings right and the workspace authority right.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (mutating) requireIntegrationPermission(context.principal, 'nnd.workspace.manage');
  if (request.method !== (mutating ? 'POST' : 'GET')) return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndTrustService;
  if (!service || typeof service.list !== 'function' || typeof service.grant !== 'function'
    || typeof service.revoke !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native trust surface is unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  if (action === 'grant' || action === 'revoke') {
    const body = await readJsonBody(request, REQUEST_BYTES);
    if (typeof body?.root !== 'string' || body.root.length < 1 || body.root.length > ROOT_MAX) throw invalid();
    const receipt = await service[action](body.root);
    if (Buffer.byteLength(JSON.stringify(receipt)) > RECEIPT_BOUND) throw invalid();
    return send(response, 200, receipt);
  }
  const projected = projectTrustList(await service.list());
  if (Buffer.byteLength(JSON.stringify(projected)) > RESPONSE_BOUND) throw invalid();
  return send(response, 200, projected);
}

export function createNativeNndTrustServices({ path, installationId, dataId }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '') || typeof path !== 'string') throw invalid();
  return Object.freeze({
    async list() { return { version: 1, workspaces: await listTrust(path), installationId, dataId }; },
    async grant(root) {
      const outcome = await trustWorkspace(path, root);
      return receipt('grant', installationId, dataId, outcome);
    },
    async revoke(root) {
      const outcome = await untrustWorkspace(path, root);
      return receipt('revoke', installationId, dataId, outcome);
    },
  });
}

function receipt(operation, installationId, dataId, outcome) {
  return Object.freeze({ schema_version: '1.0', installation_id: installationId, data_id: dataId,
    scope: 'user', operation, root: outcome.root, trusted: outcome.trusted === true,
    application: 'project_configuration' });
}

export function projectTrustList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.installationId !== 'string' || !ID.test(value.installationId)
    || typeof value.dataId !== 'string' || !ID.test(value.dataId) || value.version !== 1
    || !Array.isArray(value.workspaces)) throw invalid();
  const workspaces = value.workspaces.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'root,trustedAt' || typeof item.root !== 'string'
      || item.root.length < 1 || typeof item.trustedAt !== 'string') throw invalid();
    return { root: item.root, trusted_at: item.trustedAt };
  });
  return Object.freeze({ schema_version: '1.0', installation_id: value.installationId,
    data_id: value.dataId, scope: 'user', version: 1, workspaces, source: 'trust',
    application: 'project_configuration', fields: CENSUS_FIELDS.slice() });
}
