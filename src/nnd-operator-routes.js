// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const SESSION_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/capabilities$/u;
const STEER_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/steer$/u;

export async function dispatchNndOperatorRequest(request, response, context) {
  const capability = SESSION_ROUTE.exec(context.url.pathname);
  const steer = STEER_ROUTE.exec(context.url.pathname);
  if (!capability && !steer) return false;
  const encoded = (capability ?? steer)[1];
  let sessionId;
  try { sessionId = decodeURIComponent(encoded); requireExternalId(sessionId, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  if (request.method === 'GET' && capability) requireIntegrationPermission(context.principal, 'nnd.read');
  else if (request.method === 'POST' && steer) requireIntegrationPermission(context.principal, 'nnd.steer');
  else return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  const resolver = context.nndSessionResolver;
  if (typeof resolver !== 'function') throw new ContractError('nnd_engine_unavailable', 'NND session resolver is unavailable');
  const session = await resolver(sessionId, context.principal);
  if (!session || session.sessionId !== sessionId) return send(response, 404, { error: { code: 'session_unavailable', message: 'session is unavailable' } });
  if (request.method === 'GET' && capability) {
    return send(response, 200, { session_id: sessionId, revision: session.revision ?? 1, capabilities: { steer_subagent: session.steerSubagent === true }, availability: session.availability ?? 'unavailable' });
  }
  if (request.method === 'POST' && steer) {
    if (session.steerSubagent !== true || typeof session.steer !== 'function') {
      return send(response, 409, { error: { code: 'steering_unavailable', message: 'session has no active steering grant' } });
    }
    const body = await readJsonBody(request);
    return send(response, 202, await session.steer(body, context.principal));
  }
}
