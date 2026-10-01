// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

export async function dispatchNndQuestionRequest(request, response, context) {
  const path = context.url.pathname; const match = /^\/question\/([^/]+)\/(reply|reject)$/u.exec(path);
  if (path !== '/question' && !match) return false;
  const host = context.nndEngineHost;
  if (!host?.questions || !host?.settleQuestion) throw new ContractError('nnd_engine_unavailable', 'NND question host is unavailable');
  if (path === '/question' && request.method === 'GET') {
    requireIntegrationPermission(context.principal, 'nnd.read');
    return send(response, 200, host.questions(context.principal));
  }
  if (!match || request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.session.submit');
  let token;
  try { token = decodeURIComponent(match[1]); requireExternalId(token, 'question_token'); }
  catch { throw new ContractError('question_request_invalid', 'question identity is invalid'); }
  // Compatibility: eight rows of sixteen bounded labels can exceed 96 KiB
  // after UTF-8 encoding or JSON escaping; keep their native transport bounded.
  const body = await readJsonBody(request, match[2] === 'reply' ? 256 * 1024 : undefined);
  return send(response, 200, await host.settleQuestion(token, context.principal, body, match[2]));
}
