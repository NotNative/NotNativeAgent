// SPDX-License-Identifier: Apache-2.0
/** Native compatibility-service settings routes over /v1/nnd/configuration/compatibility-service.
 * Why: census rows for config/opencode.json (the wiring identity: enabled, hostname, port,
 * username, password, plus generated version/updated_at) need the authenticated native
 * surface the gateway settings family established in 20261005-14.
 * Invariant: secret values never project — the read shows a credential presence source
 * only (opencodePublicStatus semantics); preview never persists; receipts class
 * application as 'next_service_start' because the wiring service reads this file at its
 * next start. Compatibility: no legacy request shape exists for this family.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const BASE = '/v1/nnd/configuration/compatibility-service';
const OPERATION = /^\/v1\/nnd\/configuration\/compatibility-service\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
const EDITABLE = 'nnd.configuration.manage';
const invalid = () => new ContractError('nnd_compatibility_request_invalid', 'Native compatibility settings request is invalid.');
function field(path, definition) {
  return Object.freeze({ path, application: 'next_service_start', ...definition });
}
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'compatibility_service', scope: 'user',
  fields: Object.freeze([
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
    field('enabled', { classification: 'operator_setting', scope: 'user', required_permission: EDITABLE,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('hostname', { classification: 'operator_setting', scope: 'user', required_permission: EDITABLE,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('port', { classification: 'operator_setting', scope: 'user', required_permission: EDITABLE,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('username', { classification: 'operator_setting', scope: 'user', required_permission: EDITABLE,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('password', { classification: 'operator_setting', type: 'secret', scope: 'user',
      required_permission: EDITABLE, operations: ['replace_secret', 'clear_secret'],
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('updated_at', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export async function dispatchNndCompatibilityRequest(request, response, context) {
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
  const service = context.nndCompatibilitySettingsService;
  if (!service || typeof service.read !== 'function' || typeof service.preview !== 'function'
    || typeof service.save !== 'function' || typeof service.operation !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native compatibility settings are unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const value = action === 'read' ? await service.read(context.principal)
    : action === 'operation' ? await service.operation(context.principal, operation[1])
      : await service[action](context.principal, await readJsonBody(request, 4096));
  if (value === null) return send(response, 404, { error: 'operation_not_found' });
  const projected = action === 'read' || action === 'preview' ? projectView(value, action)
    : projectReceipt(value);
  // The 24,576-byte response bound cannot be reached by legal state: the view carries a
  // bounded hostname (253), username (64), port, a fixed-key credential presence object,
  // and never a secret value. An exceeded bound here still means projector drift.
  if (Buffer.byteLength(JSON.stringify(projected)) > 24576) throw invalid();
  return send(response, 200, projected);
}

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user'
    || value.application !== 'next_service_start') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function persistedRevision(value) {
  if (value === null) return null;
  if (typeof value === 'string' && PERSISTED_REVISION.test(value)) return value;
  throw invalid();
}
function credential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  if (value.configured !== true && value.configured !== false) throw invalid();
  if (value.source !== null && value.source !== 'restricted local config'
    && value.source !== 'environment') throw invalid();
  if ((value.configured === true) !== (value.source !== null)) throw invalid();
  return { configured: value.configured, source: value.source };
}
function wireIdentity(value) {
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'enabled,hostname,port,username' || value.enabled !== true && value.enabled !== false
    || typeof value.hostname !== 'string' || value.hostname.length < 1
    || typeof value.username !== 'string' || value.username.length < 1
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) throw invalid();
}
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false
    || !['absent', 'present'].includes(value.source_state)) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: value.source_state,
    source_revision: sourceRevision, resolution_revision: resolutionRevision,
    project_shadowed: false, version: value.version, ...wireIdentityChecked(value),
    password: credential(value.password), updated_at: value.updated_at === null ? null
      : typeof value.updated_at === 'string' ? value.updated_at : null,
    application: 'next_service_start' };
  if (action === 'read') return view;
  if (value.valid !== true) throw invalid();
  return { valid: true, expected_revision: sourceRevision, resolution_revision: resolutionRevision,
    application: 'next_service_start', view };
}
function wireIdentityChecked(value) {
  const candidate = { enabled: value.enabled, hostname: value.hostname, port: value.port, username: value.username };
  wireIdentity(candidate);
  return candidate;
}
function projectReceipt(value) {
  const selected = identity(value);
  if (!['saved', 'unpublished', 'unknown'].includes(value.persistence)
    || typeof value.operation_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operation_id)
    || value.replay_window !== 'last_128_operations') throw invalid();
  return { ...selected, operation_id: value.operation_id, persistence: value.persistence,
    before_revision: revision(value.before_revision),
    persisted_revision: persistedRevision(value.persisted_revision),
    application: 'next_service_start',
    next_action: value.persistence === 'saved' ? 'next_service_start' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
