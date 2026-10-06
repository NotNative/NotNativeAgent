// SPDX-License-Identifier: Apache-2.0
/** Native managed-MCP-credential routes over /v1/nnd/configuration/mcp-credentials.
 * Why: census row managed_mcp_credentials:credentials.{NNA_MCP_MANAGED_reference}
 * (operator_setting over config/mcp-credentials.json, validator src/mcp-credentials.js)
 * needs the authenticated native surface the settings families established.
 * Invariants: token values never project — the list carries references and an applied
 * presence flag only, and receipts carry the reference but never a token value. Reads
 * need nnd.configuration.read; save/delete need nnd.configuration.manage. The request
 * bound is 24,576 because a legal token is up to 16,384 characters (the domain's own
 * MAX_TOKEN_LENGTH). The response bound 65,536 cannot be reached by legal state:
 * ≤256 credentials × ~100-character reference rows and never a token value.
 * There is no operations ledger endpoint: save is an idempotent upsert of the derived
 * reference and delete is idempotent, so receipts claim nothing about replay.
 * The catalog pins exactly one field: credentials.{NNA_MCP_MANAGED_reference}.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const BASE = '/v1/nnd/configuration/mcp-credentials';
const EDITABLE = 'nnd.configuration.manage';
const invalid = () => new ContractError('nnd_mcp_credentials_request_invalid', 'Native MCP credential request is invalid.');
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'managed_mcp_credentials', scope: 'user',
  fields: Object.freeze([Object.freeze({
    path: 'credentials.{NNA_MCP_MANAGED_reference}', classification: 'operator_setting',
    type: 'secret', application: 'next_server_spawn', scope: 'user', required_permission: EDITABLE,
    editability: { available: true, scope: 'user', required_permission: EDITABLE } })]) });

export async function dispatchNndMcpCredentialsRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const action = path === BASE ? 'list' : path === `${BASE}/catalog` ? 'catalog'
    : path === `${BASE}/credentials/save` ? 'save'
      : path === `${BASE}/credentials/delete` ? 'remove' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  const permission = action === 'save' || action === 'remove' ? 'manage' : 'read';
  requireIntegrationPermission(context.principal, `nnd.configuration.${permission}`);
  if (request.method !== (permission === 'read' ? 'GET' : 'POST')) return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndMcpCredentialsService;
  if (!service || typeof service.read !== 'function' || typeof service.save !== 'function'
    || typeof service.remove !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native MCP credential settings are unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const value = action === 'list' ? await service.read(context.principal)
    : await service[action === 'save' ? 'save' : 'remove'](context.principal, await readJsonBody(request, 24576));
  const projected = action === 'list' ? projectList(value) : projectReceipt(value);
  // Bounded by the store's own MAX_CREDENTIALS (256) times a ~100-character reference
  // row; tokens never project, so an exceeded bound means projector drift.
  if (Buffer.byteLength(JSON.stringify(projected)) > 65536) throw invalid();
  return send(response, 200, projected);
}

function projectList(value) {
  if (value.source_state !== 'present' && value.source_state !== 'absent') throw invalid();
  if (value.application !== 'next_server_spawn' || value.scope !== 'user') throw invalid();
  if (!Array.isArray(value.credentials)) throw invalid();
  const credentials = value.credentials.map((entry) => {
    if (typeof entry?.reference !== 'string'
      || !entry.reference.startsWith('NNA_MCP_MANAGED_') || typeof entry.applied !== 'boolean'
      || Object.keys(entry).sort().join(',') !== 'applied,reference') throw invalid();
    return { reference: entry.reference, applied: entry.applied };
  });
  if (!Number.isInteger(value.count) || value.count !== credentials.length) throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: value.scope,
    source_state: value.source_state, count: value.count, credentials,
    application: value.application };
}

function projectReceipt(value) {
  if (typeof value?.reference !== 'string' || !value.reference.startsWith('NNA_MCP_MANAGED_')
    || (value.persistence !== 'saved' && value.persistence !== 'deleted' && value.persistence !== 'absent')
    || value.next_action !== 'inspect_native_operation'
    || value.application !== 'next_server_spawn') throw invalid();
  const receipt = { installation_id: value.installation_id, data_id: value.data_id, scope: value.scope,
    operation_id: value.operation_id, persistence: value.persistence, reference: value.reference,
    application: value.application, next_action: value.next_action };
  // Tokens cannot enter a receipt: the transaction only copies the listed keys.
  if (JSON.stringify(receipt).includes('"token"')) throw invalid();
  return receipt;
}
