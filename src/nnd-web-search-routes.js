// SPDX-License-Identifier: Apache-2.0
/** Native WebSearch settings routes over /v1/nnd/configuration/web-search.
 * Why: census rows for config/web-search.json (the enabled flag plus the canonical
 * SearXNG profile list) need the authenticated native surface the gateway settings
 * family established in 20261005-14.
 * Invariant: reads show the exact profile order (primary first, by domain design);
 * preview never persists; receipts class application as 'next_search' because the
 * search tool reloads the file on every search invocation.
 * Compatibility: the version-1 legacy fields (provider, endpoint, managed) normalize
 * into the version-2 profiles on load and are not projected by this surface.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { MAX_WEB_SEARCH_PROFILES, normalizeSearxngEndpoint, normalizeWebSearchProfileId } from './web-search-config.js';

const BASE = '/v1/nnd/configuration/web-search';
const OPERATION = /^\/v1\/nnd\/configuration\/web-search\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
const invalid = () => new ContractError('nnd_web_search_request_invalid', 'Native WebSearch settings request is invalid.');

const EDITABLE = 'nnd.configuration.manage';
function field(path, definition) {
  return Object.freeze({ path, classification: 'operator_setting', scope: 'user',
    required_permission: EDITABLE, application: 'next_search', ...definition });
}
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'web_search', scope: 'user',
  fields: Object.freeze([
    field('enabled', { editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }),
    field('profiles', { type: 'array', operations: ['add_profile', 'promote_profile', 'remove_profile'],
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }),
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export async function dispatchNndWebSearchRequest(request, response, context) {
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
  const service = context.nndWebSearchSettingsService;
  if (!service || typeof service.read !== 'function' || typeof service.preview !== 'function'
    || typeof service.save !== 'function' || typeof service.operation !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native WebSearch configuration is unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  // Why 131,072 bytes both ways: the domain caps the stored file at 65,536, and a
  // legal add_profile may carry an endpoint near that bound before the transform's
  // file-size validation refuses the result; the native envelope doubles it so any
  // legal domain state round-trips. An exceeded response bound here still means
  // projector drift, and an oversized request stops before validation.
  if (action === 'read' || action === 'operation') {
    const value = action === 'read' ? await service.read(context.principal)
      : await service.operation(context.principal, operation[1]);
    if (value === null) return send(response, 404, { error: 'operation_not_found' });
    const projected = action === 'read' ? projectView(value, action) : projectReceipt(value);
    if (Buffer.byteLength(JSON.stringify(projected)) > 131072) throw invalid();
    return send(response, 200, projected);
  }
  const body = await readJsonBody(request, 131072);
  const value = await service[action](context.principal, body);
  const projected = action === 'save' ? projectReceipt(value) : projectView(value, action);
  if (Buffer.byteLength(JSON.stringify(projected)) > 131072) throw invalid();
  return send(response, 200, projected);
}

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user' || value.application !== 'next_search') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function persistedRevision(value) {
  if (value === null) return null;
  if (typeof value === 'string' && PERSISTED_REVISION.test(value)) return value;
  throw invalid();
}
function fieldValues(value) {
  if (value.version !== 2 || typeof value.enabled !== 'boolean' || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_WEB_SEARCH_PROFILES) throw invalid();
  const seen = new Set(), endpoints = new Set();
  const profiles = value.profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).sort().join(',') !== 'display_name,endpoint,id,managed,provider') throw invalid();
    if (profile.provider !== 'searxng' || typeof profile.display_name !== 'string'
      || profile.display_name.length < 1 || Array.from(profile.display_name).length > 128
      || profile.managed !== true && profile.managed !== false) throw invalid();
    let endpoint;
    try { endpoint = normalizeSearxngEndpoint(profile.endpoint); } catch { throw invalid(); }
    normalizeWebSearchProfileId(profile.id);
    seen.add(profile.id); endpoints.add(endpoint);
    return { id: profile.id, display_name: profile.display_name, provider: 'searxng', endpoint, managed: profile.managed };
  });
  if (seen.size !== profiles.length || endpoints.size !== profiles.length) throw invalid();
  return { version: value.version, enabled: value.enabled, profiles };
}
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false
    || !['absent', 'present'].includes(value.source_state)) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: value.source_state,
    source_revision: sourceRevision,
    resolution_revision: resolutionRevision, project_shadowed: false, ...fieldValues(value),
    application: 'next_search' };
  if (action === 'read') return view;
  if (value.valid !== true) throw invalid();
  return { valid: true, expected_revision: sourceRevision, resolution_revision: resolutionRevision,
    application: 'next_search', view };
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
    application: 'next_search',
    next_action: value.persistence === 'saved' ? 'next_search' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
