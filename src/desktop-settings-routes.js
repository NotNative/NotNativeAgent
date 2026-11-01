// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

/** Build the HTTP surface for one native settings family.
 *
 *  Why: the WebFetch, WebSearch, compatibility, and gateway families use the
 *  same path/action/permission/method envelope and the same catalog/read/
 *  preview/save/operation responses. Only the base path, service key, catalog,
 *  projections, and bounds differ. Keeping the envelope here makes an
 *  authorization or method fix reach every family at once. */
export function createDesktopSettingsDispatcher(config) {
  const {
    base, operationPattern, serviceKey, catalog, invalid,
    projectView, projectReceipt, requestLimit, responseLimit,
    unavailableMessage, overflow = invalid,
  } = config;
  return async function dispatchDesktopSettingsRequest(request, response, context) {
    const path = context.url.pathname;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const operationMatch = operationPattern.exec(path);
    const action = path === base ? 'read' : path === `${base}/catalog` ? 'catalog'
      : path === `${base}/preview` ? 'preview' : path === `${base}/save` ? 'save'
        : operationMatch ? 'operation' : null;
    if (!action) return send(response, 404, { error: 'not_found' });
    const permission = action === 'preview' || action === 'save' ? 'manage' : 'read';
    requireIntegrationPermission(context.principal, `desktop.configuration.${permission}`);
    if (request.method !== (permission === 'read' ? 'GET' : 'POST')) {
      return send(response, 405, { error: 'method_not_allowed' });
    }
    if (context.url.search) throw invalid();
    const service = context[serviceKey];
    if (!service || typeof service.read !== 'function' || typeof service.preview !== 'function'
      || typeof service.save !== 'function' || typeof service.operation !== 'function') {
      throw new ContractError('desktop_configuration_unavailable', unavailableMessage);
    }
    if (action === 'catalog') return send(response, 200, catalog);
    if (action === 'read' || action === 'operation') {
      const value = action === 'read' ? await service.read(context.principal)
        : await service.operation(context.principal, operationMatch[1]);
      if (value === null) return send(response, 404, { error: 'operation_not_found' });
      const projected = action === 'read' ? projectView(value, action) : projectReceipt(value);
      if (Buffer.byteLength(JSON.stringify(projected)) > responseLimit) throw overflow();
      return send(response, 200, projected);
    }
    const body = await readJsonBody(request, requestLimit);
    const value = await service[action](context.principal, body);
    const projected = action === 'save' ? projectReceipt(value) : projectView(value, action);
    if (Buffer.byteLength(JSON.stringify(projected)) > responseLimit) throw overflow();
    return send(response, 200, projected);
  };
}
