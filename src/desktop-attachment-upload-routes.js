// SPDX-License-Identifier: Apache-2.0
/** Authenticated upload admission precedes any native prompt acknowledgement. */
import { admittedWorkspaceContext } from './desktop-workspace-request-context.js';
import { ContractError, requireExternalId } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

const ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/attachments$/u;
const BODY_BYTES = 1_400_000;

export async function dispatchDesktopAttachmentUploadRequest(request, response, context) {
  const match = ROUTE.exec(context.url.pathname);
  if (!match) return false;
  context = await admittedWorkspaceContext(context);
  if (request.method !== 'POST') return send(response, 405,
    { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'desktop.session.submit');
  let sessionId;
  try { sessionId = decodeURIComponent(match[1]); requireExternalId(sessionId, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  const host = context.desktopEngineHost;
  if (!host?.uploadAttachment) throw new ContractError('desktop_engine_unavailable', 'desktop upload host is unavailable');
  const body = await readJsonBody(request, BODY_BYTES);
  return send(response, 201, await host.uploadAttachment(sessionId, context.principal, body));
}
