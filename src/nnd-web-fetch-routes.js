// SPDX-License-Identifier: Apache-2.0
/** Native WebFetch trust settings routes over /v1/nnd/configuration/web-fetch.
 * Why: census rows for config/web-fetch.json (trusted_origins authority grant plus the
 * generated version/updated_at pair) need the authenticated native surface the gateway
 * settings family established in 20261005-14.
 * Invariant: reads show the exact origin list (public authority grants, not secrets);
 * preview never persists; receipts class application as 'next_fetch' because the
 * destination policy reloads the file on every fetch.
 * Compatibility: no legacy request shape exists for this family.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { normalizeTrustedOrigin } from './web-fetch-config.js';

const BASE = '/v1/nnd/configuration/web-fetch';
const OPERATION = /^\/v1\/nnd\/configuration\/web-fetch\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const invalid = () => new ContractError('nnd_web_fetch_request_invalid', 'Native WebFetch settings request is invalid.');

const EDITABLE = 'nnd.configuration.manage';
function field(path, definition) {
  return Object.freeze({ path, classification: 'operator_setting', scope: 'user',
    required_permission: EDITABLE, application: 'next_fetch', ...definition });
}
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'web_fetch', scope: 'user',
  fields: Object.freeze([
    field('trusted_origins', { classification: 'authority_grant', type: 'array',
      operations: ['trust', 'revoke'],
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }),
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
    field('updated_at', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export async function dispatchNndWebFetchRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const operation = OPERATION.exec(path);
  const action = path === BASE ? 'read' : path === `${BASE}/catalog` ? 'catalog'
    : path === `${BASE}/preview` ? 'preview' : path === `${BASE}/save` ? 'save'
      : operation ? 'operation' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  const permission = action === 'preview' || action === 'save' ? 'manage' : 'read';
  requireIntegrationPermission(context.principal, `nnd.configuration.${permission}`);
  if (request.method !== (permission === 'read' ? 'GET' : 'POST')) return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndWebFetchSettingsService;
  if (!service || typeof service.read !== 'function' || typeof service.preview !== 'function'
    || typeof service.save !== 'function' || typeof service.operation !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native WebFetch configuration is unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const value = action === 'read' ? await service.read(context.principal)
    : action === 'operation' ? await service.operation(context.principal, operation[1])
      : await service[action](context.principal, await readJsonBody(request, 4096));
  if (value === null) return send(response, 404, { error: 'operation_not_found' });
  const projected = action === 'read' || action === 'preview' ? projectView(value, action) : projectReceipt(value);
  // The 24,576-byte response bound cannot be reached by legal state: the domain caps
  // origins at 300 characters (see normalizeTrustedOrigin), so 64 origins x ~303 JSON
  // bytes stays far inside it. An exceeded bound here still means projector drift.
  if (Buffer.byteLength(JSON.stringify(projected)) > 24576) throw invalid();
  return send(response, 200, projected);
}

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user' || value.application !== 'next_fetch') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function persistedRevision(value) {
  if (value === null) return null;
  if (typeof value === 'string' && PERSISTED_REVISION.test(value)) return value;
  throw invalid();
}
function fieldValues(value) {
  if (value.version !== 1 || !Array.isArray(value.trusted_origins) || value.trusted_origins.length > 64
    || value.updated_at !== null && !TIMESTAMP.test(value.updated_at ?? '')) throw invalid();
  let origins;
  try { origins = value.trusted_origins.map((origin) => normalizeTrustedOrigin(origin)); } catch { throw invalid(); }
  const sorted = [...new Set(origins)].sort();
  if (origins.length !== sorted.length || origins.join('|') !== sorted.join('|')) throw invalid();
  return { version: value.version, trusted_origins: origins, updated_at: value.updated_at };
}
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false
    || !['absent', 'present'].includes(value.source_state)) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: value.source_state,
    source_revision: sourceRevision,
    resolution_revision: resolutionRevision, project_shadowed: false, ...fieldValues(value),
    application: 'next_fetch' };
  if (action === 'read') return view;
  if (value.valid !== true) throw invalid();
  return { valid: true, expected_revision: sourceRevision, resolution_revision: resolutionRevision,
    application: 'next_fetch', view };
}
function projectReceipt(value) {
  const selected = identity(value);
  if (!['saved', 'unpublished', 'unknown'].includes(value.persistence)
    || typeof value.operation_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operation_id)
    || value.replay_window !== 'last_128_operations') throw invalid();
  return { ...selected, operation_id: value.operation_id, persistence: value.persistence,
    before_revision: revision(value.before_revision),
    // Invariant: a saved receipt necessarily overwrote some bytes, so its persisted
    // revision is always a digest; the fail-closed pairing stays (an invalid digest
    // rejects instead of degrading to null).
    persisted_revision: persistedRevision(value.persisted_revision),
    application: 'next_fetch',
    next_action: value.persistence === 'saved' ? 'next_fetch' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
