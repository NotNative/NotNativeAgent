// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
const ROUTE = /^\/session(?:\/([^/]+))?(?:\/(message))?$/u;
export async function dispatchNndHarnessRequest(request, response, context) {
  const match = ROUTE.exec(context.url.pathname); if (!match) return false;
  const host = context.nndEngineHost; if (!host) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  let id = null;
  if (match[1]) {
    try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
    catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  }
  if (request.method === 'GET') { requireIntegrationPermission(context.principal, 'nnd.read'); return send(response, 200, match[2] ? host.messages(id, context.principal) : id ? host.get(id, context.principal) : host.list(context.principal)); }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(context.principal, 'nnd.session.create');
    const body = await readJsonBody(request);
    const options = createOptions(body);
    const made = await host.create(newId('ses'), context.principal, options);
    return send(response, 201, host.get(made.sessionId, context.principal));
  }
  return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
}

function createOptions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContractError('request_invalid', 'NND session creation requires an object body');
  }
  // The authenticated host selects engine configuration and workspace roots.  In
  // particular, a desktop client must not be able to inject factory options such
  // as a data path or execution manifest through this compatibility endpoint.
  return typeof body.title === 'string' ? { title: body.title } : {};
}
