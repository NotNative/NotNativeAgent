// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

const BASE = '/v1/nnd/configuration/gateway';
const OPERATION = /^\/v1\/nnd\/configuration\/gateway\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const invalid = () => new ContractError('nnd_gateway_timeout_request_invalid', 'Native gateway settings request is invalid.');

const EDITABLE = 'nnd.configuration.manage';
function field(path, definition) {
  return Object.freeze({ path, classification: 'operator_setting', scope: 'user',
    required_permission: EDITABLE, application: 'restart_gateway', ...definition });
}
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'gateway', scope: 'user',
  fields: Object.freeze([
    field('enabled', { type: 'boolean', editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('token', { type: 'string', sensitivity: 'secret', operations: ['set_token', 'clear_token'],
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('token_env', { type: 'string', default: 'NNA_TELEGRAM_BOT_TOKEN',
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('workspace_root', { type: 'string', unset: { null: 'unset' },
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('polling_timeout_seconds', { type: 'integer', minimum: 5, maximum: 50,
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('authorized_user_ids', { classification: 'authority_grant', type: 'array',
      operations: ['authorize', 'revoke'],
      editability: { available: true, scope: 'user', required_permission: EDITABLE } }),
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
    field('updated_at', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export async function dispatchNndGatewayTimeoutRequest(request, response, context) {
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
  const service = context.nndGatewayTimeoutService;
  if (!service || typeof service.read !== 'function' || typeof service.preview !== 'function'
    || typeof service.save !== 'function' || typeof service.operation !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native gateway configuration is unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const value = action === 'read' ? await service.read(context.principal)
    : action === 'operation' ? await service.operation(context.principal, operation[1])
      : await service[action](context.principal, await readJsonBody(request, 4096));
  if (value === null) return send(response, 404, { error: 'operation_not_found' });
  const projected = action === 'read' || action === 'preview' ? projectView(value, action) : projectReceipt(value);
  if (Buffer.byteLength(JSON.stringify(projected)) > 8192) throw invalid();
  return send(response, 200, projected);
}

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user' || value.application !== 'not_applied') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function fieldValues(value) {
  if (!Number.isInteger(value.version) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || typeof value.token_present !== 'boolean' || typeof value.token_env !== 'string'
    || value.token_env.length > 128 || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value.token_env)
    || !Array.isArray(value.authorized_user_ids) || value.authorized_user_ids.some((id) => !/^[1-9][0-9]{0,19}$/u.test(String(id)))
    || (value.workspace_root !== null && (typeof value.workspace_root !== 'string' || value.workspace_root.length > 4096))
    || !Number.isInteger(value.polling_timeout_seconds) || value.polling_timeout_seconds < 5
    || value.polling_timeout_seconds > 50
    || (value.updated_at !== null && !/^\d{4}-\d{2}-\d{2}T[0-9:.]{8,19}Z$/u.test(value.updated_at))) throw invalid();
  const fields = { version: value.version, enabled: value.enabled, token_present: value.token_present,
    token_env: value.token_env, authorized_user_ids: [...value.authorized_user_ids],
    workspace_root: value.workspace_root, polling_timeout_seconds: value.polling_timeout_seconds,
    updated_at: value.updated_at };
  // Invariant: the projector must never carry the token itself, only its presence.
  if (JSON.stringify(fields).includes('"token":') || Object.hasOwn(fields, 'token')) throw invalid();
  return fields;
}
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: 'present', source_revision: sourceRevision,
    resolution_revision: resolutionRevision, project_shadowed: false, ...fieldValues(value),
    application: 'not_applied' };
  if (action === 'read') return view;
  if (value.valid !== true) throw invalid();
  return { valid: true, expected_revision: sourceRevision, resolution_revision: resolutionRevision,
    application: 'not_applied', view };
}
function projectReceipt(value) {
  const selected = identity(value);
  if (!['saved', 'unpublished', 'unknown'].includes(value.persistence)
    || typeof value.operation_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operation_id)
    || value.replay_window !== 'last_128_operations') throw invalid();
  if (JSON.stringify(value).includes('"token"')) throw invalid();
  return { ...selected, operation_id: value.operation_id, persistence: value.persistence,
    before_revision: revision(value.before_revision),
    persisted_revision: value.persisted_revision === null ? null : revision(value.persisted_revision),
    application: 'not_applied', next_action: value.persistence === 'saved' ? 'restart_gateway' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
