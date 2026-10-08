// SPDX-License-Identifier: Apache-2.0
/** Native workspace admission routes (F1), served beside the grant family.
 * Why: the F1 admission contract rides the SAME /v1/nnd/workspaces base as the
 * grant routes (new subpositions only), so the typed desktop client discovers
 * one family. Base GET keeps the pinned single-root grant projection untouched
 * (the desktop reader requires selection_enabled:false there); the multi-root
 * projection is the new /admissions read, mutations are POST /admissions and
 * POST /admissions/revoke with the settings-grammar body, and idempotent
 * receipt lookup lives at /admissions/operations/:id — the same shape the
 * settings families serve.
 * Security: the dispatcher itself performs the permission split exactly like
 * the grant family (nnd.workspace.read for the projection and receipts,
 * nnd.workspace.manage for admit/revoke), enforces an exact five-key request
 * grammar, refuses query strings, bounds bodies at 8 KiB, and lets typed
 * ContractError codes map through the family status table (404
 * target_missing/operation, 409 conflict, default 400 grammar).
 */
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readCanonicalGrant } from './nnd-workspace-grants.js';
import { readJsonBody, send } from './secret-broker-server.js';

const BASE = '/v1/nnd/workspaces';
const ADMIT = `${BASE}/admissions`;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const OPERATION = /^\/v1\/nnd\/workspaces\/admissions\/operations\/([A-Za-z0-9_-]{1,128})$/u;
const ADMISSION_BODY_KEYS = ['installation_id', 'data_id', 'expected_revision', 'operation_id', 'root'];
const invalid = () => new ContractError('nnd_workspace_admission_request_invalid', 'Native workspace admission request is invalid.');

export async function dispatchNndWorkspaceAdmissionRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== ADMIT && !path.startsWith(ADMIT + '/')) return false;
  const operation = OPERATION.exec(path);
  const revoking = path === `${ADMIT}/revoke`;
  if (path !== ADMIT && !operation && !revoking) return send(response, 404, { error: 'not_found' });
  // Method routing BEFORE authorization, like the settings families: an
  // unsupported method is a route contract refusal (405) that must not leak
  // which permission it would have needed.
  if (operation ? request.method !== 'GET'
    : revoking ? request.method !== 'POST'
      : request.method !== 'GET' && request.method !== 'POST') {
    return send(response, 405, { error: 'method_not_allowed' });
  }
  const mutating = request.method === 'POST';
  requireIntegrationPermission(context.principal, mutating ? 'nnd.workspace.manage' : 'nnd.workspace.read');
  if (context.url.search) throw invalid();
  const service = context.nndWorkspaceAdmissionService;
  if (!service) throw new ContractError('nnd_workspace_admission_unavailable', 'Native workspace admission service is unavailable.');
  if (operation) {
    const result = await service.operation(context.principal, operation[1]);
    return result ? send(response, 200, result) : send(response, 404, { error: 'operation_not_found' });
  }
  if (!mutating) return send(response, 200, await service.inventory(context.principal));
  const input = await readJsonBody(request, 8192);
  if (!record(input) || Object.keys(input).length !== ADMISSION_BODY_KEYS.length
    || ADMISSION_BODY_KEYS.some(key => !Object.hasOwn(input, key))
    || !ID.test(input.installation_id) || !ID.test(input.data_id) || !ID.test(input.operation_id)
    || !REVISION.test(input.expected_revision) || typeof input.root !== 'string') throw invalid();
  if (!revoking) return send(response, 200, await service.admit(context.principal, input));
  const inventory = await service.inventory(context.principal);
  const liveIdentity = await readCanonicalGrant(input.root).catch(() => null);
  const canonical = [...inventory.admitted, ...inventory.unavailable].find(row => row.root === input.root
    || liveIdentity && row.id === liveIdentity.id && row.root === liveIdentity.root);
  if (!canonical) throw new ContractError('nnd_workspace_admission_target_missing', 'The workspace root is not admitted.');
  const guarded = context.nndEngineHost?.withWorkspaceRevocation;
  if (typeof guarded !== 'function') throw new ContractError('nnd_workspace_admission_unavailable', 'Native session guard is unavailable.');
  return send(response, 200, await guarded.call(context.nndEngineHost, canonical.root,
    () => service.revoke(context.principal, input)));
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
