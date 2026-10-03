// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

const BASE = '/v1/nnd/configuration/gateway';
const OPERATION = /^\/v1\/nnd\/configuration\/gateway\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const invalid = () => new ContractError('nnd_gateway_timeout_request_invalid', 'Native gateway timeout request is invalid.');

const CATALOG = Object.freeze({ schema_version: '1.0', source: 'gateway', scope: 'user',
  fields: Object.freeze([{ path: 'polling_timeout_seconds', classification: 'operator_setting',
    type: 'integer', minimum: 5, maximum: 50, application: 'restart_gateway',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }]) });

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
  if (Buffer.byteLength(JSON.stringify(projected)) > 4096) throw invalid();
  return send(response, 200, projected);
}

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user' || value.application !== 'not_applied') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false
    || !Number.isInteger(value.polling_timeout_seconds) || value.polling_timeout_seconds < 5
    || value.polling_timeout_seconds > 50) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: 'present', source_revision: sourceRevision,
    resolution_revision: resolutionRevision, project_shadowed: false,
    polling_timeout_seconds: value.polling_timeout_seconds, application: 'not_applied' };
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
  return { ...selected, operation_id: value.operation_id, persistence: value.persistence,
    before_revision: revision(value.before_revision),
    persisted_revision: value.persisted_revision === null ? null : revision(value.persisted_revision),
    application: 'not_applied', next_action: value.persistence === 'saved' ? 'restart_gateway' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
