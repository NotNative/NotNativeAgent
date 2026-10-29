// SPDX-License-Identifier: Apache-2.0
import { CONFIGURATION_CATALOG } from './configuration-catalog.js';
import { DESKTOP_CONFIGURATION_EDITABLE_FIELDS, DESKTOP_ROUTE_BINDING_FIELDS } from './desktop-configuration-intents.js';
import { projectDesktopConfigurationView } from './desktop-configuration-view.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { ContractError } from './ids.js';
import { isRegisteredFailureCode } from './error-code-registry.js';
import { dispatchDesktopMcpConfigurationRequest } from './desktop-mcp-configuration-routes.js';
import { dispatchDesktopGatewayTimeoutRequest } from './desktop-gateway-timeout-routes.js';
import { dispatchDesktopWebFetchRequest } from './desktop-web-fetch-routes.js';
import { dispatchDesktopWebSearchRequest } from './desktop-web-search-routes.js';
import { dispatchDesktopEnvironmentRequest } from './desktop-environment-route.js';
import { dispatchDesktopInstallationRequest } from './desktop-installation-route.js';
import { dispatchDesktopBrowserRequest } from './desktop-browser-routes.js';
import { dispatchDesktopSkillsRequest } from './desktop-skills-routes.js';
import { dispatchDesktopProviderObservationRequest } from './desktop-provider-observation-routes.js';
import { dispatchDesktopLegacyProviderCredentialsRequest } from './desktop-legacy-provider-credentials-routes.js';
import { dispatchDesktopActionTriageRequest } from './desktop-action-triage-routes.js';
import { dispatchDesktopInvocationRequest } from './desktop-invocation-routes.js';
import { dispatchDesktopMcpAdvancedRequest } from './desktop-mcp-advanced-routes.js';
import { dispatchDesktopUpdateStateRequest } from './desktop-update-state-route.js';
import { dispatchDesktopTrustRequest } from './desktop-trust-routes.js';
import { dispatchDesktopCompatibilityRequest } from './desktop-compatibility-routes.js';
import { dispatchDesktopCompatibilityLifecycleRequest } from './desktop-compatibility-lifecycle-routes.js';
import { dispatchDesktopMcpCredentialsRequest } from './desktop-mcp-credentials-routes.js';
import { dispatchDesktopSecretsRequest } from './desktop-secrets-routes.js';
import { dispatchDesktopHooksRequest } from './desktop-hooks-routes.js';
import { dispatchDesktopUpdateActionsRequest } from './desktop-update-actions-routes.js';
import { dispatchDesktopPackageRequest } from './desktop-package-routes.js';

const BASE = '/v1/desktop/configuration';
const REQUEST_BYTES = 65536;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const FIELDS = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision'];
const NATIVE_EDITABLE = new Set(DESKTOP_CONFIGURATION_EDITABLE_FIELDS);
const ROUTE_BINDING = new Set(DESKTOP_ROUTE_BINDING_FIELDS);
const COUPLED_MEMORY = new Set(['memory.enabled', 'memory.required']);
const AVAILABILITY_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'ETIMEDOUT']);
function invalid() { return new ContractError('desktop_configuration_request_invalid', 'Configuration request is outside the supported native contract.'); }
function outputInvalid() { return new ContractError('desktop_configuration_internal_failure', 'Native configuration response violates its safe projection contract.'); }

export async function dispatchDesktopConfigurationRequest(request, response, context) {
  try { return await dispatchConfigurationRequest(request, response, context); }
  catch (error) {
    // A sub-route may have started a response before a later operation fails.
    // The caller must not try to serialize a second HTTP error over those bytes.
    if (response.headersSent || response.writableEnded || response.destroyed) {
      // Security: the native exception may contain private source material;
      // socket teardown does not need that exception as an argument.
      if (!response.writableEnded && !response.destroyed) response.destroy?.();
      return true;
    }
    // Security: parser and filesystem diagnostics may contain private source keys or native paths.
    // Registered failure codes surface verbatim (their text is registry-controlled);
    // known filesystem availability errors map to 503; programming faults map to 500.
    const registered = error instanceof ContractError && isRegisteredFailureCode(error.code);
    const code = error?.code === 'desktop_configuration_view_invalid' ? 'desktop_configuration_internal_failure'
      : registered ? error.code : AVAILABILITY_CODES.has(error?.code)
      ? 'desktop_configuration_unavailable' : 'desktop_configuration_internal_failure';
    throw new ContractError(code, 'Native configuration request could not be completed.', { cause: error });
  }
}

async function dispatchConfigurationRequest(request, response, context) {
  const url = context.url;
  if (url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) return false;
  if (await dispatchDesktopActionTriageRequest(request, response, context)) return true;
  if (await dispatchDesktopInvocationRequest(request, response, context)) return true;
  if (await dispatchDesktopMcpAdvancedRequest(request, response, context)) return true;
  if (await dispatchDesktopGatewayTimeoutRequest(request, response, context)) return true;
  if (await dispatchDesktopWebFetchRequest(request, response, context)) return true;
  if (await dispatchDesktopWebSearchRequest(request, response, context)) return true;
  if (await dispatchDesktopEnvironmentRequest(request, response, context)) return true;
  if (await dispatchDesktopInstallationRequest(request, response, context)) return true;
  if (await dispatchDesktopBrowserRequest(request, response, context)) return true;
  if (await dispatchDesktopSkillsRequest(request, response, context)) return true;
  if (await dispatchDesktopProviderObservationRequest(request, response, context)) return true;
  if (await dispatchDesktopLegacyProviderCredentialsRequest(request, response, context)) return true;
  if (await dispatchDesktopUpdateStateRequest(request, response, context)) return true;
  if (await dispatchDesktopTrustRequest(request, response, context)) return true;
  if (await dispatchDesktopCompatibilityLifecycleRequest(request, response, context)) return true;
  if (await dispatchDesktopCompatibilityRequest(request, response, context)) return true;
  if (await dispatchDesktopMcpCredentialsRequest(request, response, context)) return true;
  if (await dispatchDesktopSecretsRequest(request, response, context)) return true;
  if (await dispatchDesktopHooksRequest(request, response, context)) return true;
  if (await dispatchDesktopUpdateActionsRequest(request, response, context)) return true;
  if (await dispatchDesktopPackageRequest(request, response, context)) return true;
  if (await dispatchDesktopMcpConfigurationRequest(request, response, context)) return true;
  const route = routeFor(url.pathname);
  if (!route) return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, `desktop.configuration.${route.permission}`);
  if (request.method !== route.method) return send(response, 405, { error: 'method_not_allowed' });
  if (url.search) throw invalid();
  if (route.action === 'catalog') return boundedSend(response, nativeCatalog(context.desktopConfigurationService));
  const service = context.desktopConfigurationService;
  if (!service || typeof service[route.action] !== 'function') {
    throw new ContractError('desktop_configuration_unavailable', 'Native configuration service is unavailable.');
  }
  if (route.action === 'read') return boundedSend(response, projectDesktopConfigurationView(await service.read(context.principal)));
  if (route.action === 'operation') {
    const receipt = await service.operation(context.principal, route.operationId);
    return receipt ? boundedSend(response, projectReceipt(receipt)) : send(response, 404, { error: 'operation_not_found' });
  }
  const input = await readJsonBody(request, REQUEST_BYTES);
  validateInput(input, route.action);
  const result = await service[route.action](context.principal, input);
  if (route.action === 'preview') {
    if (result.valid !== true) throw outputInvalid();
    return boundedSend(response, { valid: true, expected_revision: safeRevision(result.expected_revision),
      resolution_revision: safeRevision(result.resolution_revision), application: 'not_applied',
      view: projectDesktopConfigurationView(result.snapshot) });
  }
  return boundedSend(response, projectReceipt(result));
}

function nativeCatalog(service) {
  const supportsSave = typeof service?.save === 'function';
  return { ...CONFIGURATION_CATALOG, fields: CONFIGURATION_CATALOG.fields.map((field) => {
    if (!supportsSave || (!NATIVE_EDITABLE.has(field.path) && !ROUTE_BINDING.has(field.path))) return field;
    return { ...field, editability: { ...field.editability, available: true,
      scope: 'user', required_permission: 'desktop.configuration.manage',
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
  const match = /^\/v1\/desktop\/configuration\/operations\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
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
function safeRevision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw outputInvalid(); return value; }
function safeId(value) { if (typeof value !== 'string' || !ID.test(value)) throw outputInvalid(); return value; }
function projectReceipt(value) {
  if (!value || !['saved', 'unpublished', 'unknown'].includes(value.persistence) || value.scope !== 'user'
    || value.application !== 'not_applied') throw outputInvalid();
  return { installation_id: safeId(value.installation_id), data_id: safeId(value.data_id), scope: 'user',
    operation_id: safeId(value.operation_id), persistence: value.persistence,
    persisted_revision: value.persisted_revision === null ? null : safeRevision(value.persisted_revision),
    before_revision: safeRevision(value.before_revision), application: 'not_applied',
    next_action: value.persistence === 'saved' ? 'activate_setup_or_restart_native_service' : 'inspect_native_operation', replayed: value.replayed === true,
    replay_window: 'last_128_operations' };
}
function boundedSend(response, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_BYTES) throw outputInvalid();
  return send(response, 200, value);
}
