// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

const BASE = '/v1/nnd/workspaces';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const invalid = () => new ContractError('nnd_workspace_grant_request_invalid', 'Native workspace grant request is invalid.');

export async function dispatchNndWorkspaceGrantRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(BASE + '/')) return false;
  const operation = /^\/v1\/nnd\/workspaces\/operations\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
  if (path !== BASE && !operation) return send(response, 404, { error: 'not_found' });
  const permission = request.method === 'POST' && path === BASE ? 'nnd.workspace.manage' : 'nnd.workspace.read';
  requireIntegrationPermission(context.principal, permission);
  if (!['GET', 'POST'].includes(request.method) || (operation && request.method !== 'GET')) {
    return send(response, 405, { error: 'method_not_allowed' });
  }
  if (context.url.search) throw invalid();
  const service = context.nndWorkspaceGrantService;
  if (!service) throw new ContractError('nnd_workspace_grant_unavailable', 'Native workspace grant service is unavailable.');
  if (operation) {
    const result = await service.operation(context.principal, operation[1]);
    return result ? send(response, 200, result) : send(response, 404, { error: 'operation_not_found' });
  }
  if (request.method === 'GET') return send(response, 200, await service.read(context.principal));
  const input = await readJsonBody(request, 8192);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 5
    || ['installation_id', 'data_id', 'expected_revision', 'operation_id', 'secondary_root'].some(key => !Object.hasOwn(input, key))
    || !ID.test(input.installation_id) || !ID.test(input.data_id) || !ID.test(input.operation_id)
    || !REVISION.test(input.expected_revision)
    || !(input.secondary_root === null || typeof input.secondary_root === 'string')) throw invalid();
  return send(response, 200, await service.save(context.principal, input));
}
