// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

export async function dispatchNndNotificationRequest(request, response, context) {
  const match = /^\/v1\/nnd\/sessions\/([^/]+)\/notification-text$/u.exec(context.url.pathname);
  if (!match) return false;
  if (request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.notification.generate');
  let id;
  try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  if (!context.nndEngineHost?.generateNotification) throw new ContractError('nnd_engine_unavailable', 'NND notification generation is unavailable');
  return send(response, 200, await context.nndEngineHost.generateNotification(id, context.principal, await readJsonBody(request)));
}
