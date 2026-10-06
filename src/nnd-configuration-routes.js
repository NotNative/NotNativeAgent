// SPDX-License-Identifier: Apache-2.0
import { CONFIGURATION_CATALOG } from './configuration-catalog.js';
import { NND_CONFIGURATION_EDITABLE_FIELDS, NND_ROUTE_BINDING_FIELDS } from './nnd-configuration-intents.js';
import { projectNndConfigurationView } from './nnd-configuration-view.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { ContractError } from './ids.js';
import { dispatchNndMcpConfigurationRequest } from './nnd-mcp-configuration-routes.js';
import { dispatchNndGatewayTimeoutRequest } from './nnd-gateway-timeout-routes.js';
import { dispatchNndWebFetchRequest } from './nnd-web-fetch-routes.js';
import { dispatchNndWebSearchRequest } from './nnd-web-search-routes.js';
import { dispatchNndEnvironmentRequest } from './nnd-environment-route.js';
import { dispatchNndUpdateStateRequest } from './nnd-update-state-route.js';
import { dispatchNndTrustRequest } from './nnd-trust-routes.js';
import { dispatchNndCompatibilityRequest } from './nnd-compatibility-routes.js';
import { dispatchNndMcpCredentialsRequest } from './nnd-mcp-credentials-routes.js';

const BASE = '/v1/nnd/configuration';
const REQUEST_BYTES = 65536;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const FIELDS = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision'];
const NATIVE_EDITABLE = new Set(NND_CONFIGURATION_EDITABLE_FIELDS);
const ROUTE_BINDING = new Set(NND_ROUTE_BINDING_FIELDS);
const COUPLED_MEMORY = new Set(['memory.enabled', 'memory.required']);
function invalid() { return new ContractError('nnd_configuration_request_invalid', 'Configuration request is outside the supported native contract.'); }

export async function dispatchNndConfigurationRequest(request, response, context) {
  try { return await dispatchConfigurationRequest(request, response, context); }
  catch (error) {
    // Security: parser and filesystem diagnostics may contain private source keys or native paths.
    const code = error instanceof ContractError && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code : 'nnd_configuration_unavailable';
    throw new ContractError(code, 'Native configuration request could not be completed.');
  }
}

async function dispatchConfigurationRequest(request, response, context) {
  const url = context.url;
  if (url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) return false;
  if (await dispatchNndGatewayTimeoutRequest(request, response, context)) return true;
  if (await dispatchNndWebFetchRequest(request, response, context)) return true;
  if (await dispatchNndWebSearchRequest(request, response, context)) return true;
  if (await dispatchNndEnvironmentRequest(request, response, context)) return true;
  if (await dispatchNndUpdateStateRequest(request, response, context)) return true;
  if (await dispatchNndTrustRequest(request, response, context)) return true;
  if (await dispatchNndCompatibilityRequest(request, response, context)) return true;
  if (await dispatchNndMcpCredentialsRequest(request, response, context)) return true;
  if (await dispatchNndMcpConfigurationRequest(request, response, context)) return true;
  const route = routeFor(url.pathname);
  if (!route) return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, `nnd.configuration.${route.permission}`);
  if (request.method !== route.method) return send(response, 405, { error: 'method_not_allowed' });
  if (url.search) throw invalid();
  if (route.action === 'catalog') return boundedSend(response, nativeCatalog(context.nndConfigurationService));
  const service = context.nndConfigurationService;
  if (!service || typeof service[route.action] !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native configuration service is unavailable.');
  }
  if (route.action === 'read') return boundedSend(response, projectNndConfigurationView(await service.read(context.principal)));
  if (route.action === 'operation') {
    const receipt = await service.operation(context.principal, route.operationId);
    return receipt ? boundedSend(response, projectReceipt(receipt)) : send(response, 404, { error: 'operation_not_found' });
  }
  const input = await readJsonBody(request, REQUEST_BYTES);
  validateInput(input, route.action);
  const result = await service[route.action](context.principal, input);
  if (route.action === 'preview') {
    if (result.valid !== true) throw invalid();
    return boundedSend(response, { valid: true, expected_revision: safeRevision(result.expected_revision),
      resolution_revision: safeRevision(result.resolution_revision), application: 'not_applied',
      view: projectNndConfigurationView(result.snapshot) });
  }
  return boundedSend(response, projectReceipt(result));
}

function nativeCatalog(service) {
  const supportsSave = typeof service?.save === 'function';
  return { ...CONFIGURATION_CATALOG, fields: CONFIGURATION_CATALOG.fields.map((field) => {
    if (!supportsSave || (!NATIVE_EDITABLE.has(field.path) && !ROUTE_BINDING.has(field.path))) return field;
    return { ...field, editability: { ...field.editability, available: true,
      scope: 'user', required_permission: 'nnd.configuration.manage',
      ...(COUPLED_MEMORY.has(field.path) ? { coupled_fields: ['memory.enabled', 'memory.required'] } : {}),
      ...(ROUTE_BINDING.has(field.path) ? { operation: 'bind_route', paired_fields: [
        field.path.replace(/\.(?:provider_id|model)$/u, '.provider_id'),
        field.path.replace(/\.(?:provider_id|model)$/u, '.model')] } : {}) } };
  }) };
}

function routeFor(path) {
  if (path === BASE) return { action: 'read', method: 'GET', permission: 'read' };
  if (path === BASE + '/catalog') return { action: 'catalog', method: 'GET', permission: 'read' };
  for (const action of ['preview', 'save', 'repair']) {
    if (path === BASE + '/' + action) return { action, method: 'POST', permission: action === 'repair' ? 'repair' : 'manage' };
  }
  const match = /^\/v1\/nnd\/configuration\/operations\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
  return match ? { action: 'operation', method: 'GET', permission: 'read', operationId: match[1] } : null;
}

function validateInput(input, action) {
  const extra = action === 'repair' ? ['operation_id', 'document'] : action === 'save' ? ['operation_id', 'operations'] : ['operations'];
  const keys = [...FIELDS, ...extra];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.installation_id !== 'string' || !ID.test(input.installation_id)
    || typeof input.data_id !== 'string' || !ID.test(input.data_id) || input.scope !== 'user'
    || typeof input.expected_revision !== 'string' || !REVISION.test(input.expected_revision)) throw invalid();
  if (action !== 'repair' && (typeof input.expected_resolution_revision !== 'string' || !REVISION.test(input.expected_resolution_revision))) throw invalid();
  if (action !== 'preview' && (typeof input.operation_id !== 'string' || !ID.test(input.operation_id))) throw invalid();
  if (action === 'repair') {
    if (!input.document || typeof input.document !== 'object' || Array.isArray(input.document)) throw invalid();
  } else if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 32) throw invalid();
}
function safeRevision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function safeId(value) { if (typeof value !== 'string' || !ID.test(value)) throw invalid(); return value; }
function projectReceipt(value) {
  if (!value || !['saved', 'unpublished', 'unknown'].includes(value.persistence) || value.scope !== 'user'
    || value.application !== 'not_applied') throw invalid();
  return { installation_id: safeId(value.installation_id), data_id: safeId(value.data_id), scope: 'user',
    operation_id: safeId(value.operation_id), persistence: value.persistence,
    persisted_revision: value.persisted_revision === null ? null : safeRevision(value.persisted_revision),
    before_revision: safeRevision(value.before_revision), application: 'not_applied',
    next_action: value.persistence === 'saved' ? 'activate_setup_or_restart_native_service' : 'inspect_native_operation', replayed: value.replayed === true,
    replay_window: 'last_128_operations' };
}
function boundedSend(response, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_BYTES) throw invalid();
  return send(response, 200, value);
}
