// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readJsonBody, send } from './secret-broker-server.js';

const BASE = '/v1/nnd/configuration/mcp';
const OPERATION = /^\/v1\/nnd\/configuration\/mcp\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const invalid = () => new ContractError('nnd_mcp_request_invalid', 'Native MCP request is invalid.');

export async function dispatchNndMcpConfigurationRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const operation = OPERATION.exec(path);
  const action = path === BASE ? 'mcpRead' : path === `${BASE}/preview` ? 'mcpPreview'
    : path === `${BASE}/save` ? 'mcpSave' : operation ? 'mcpOperation' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  const permission = action === 'mcpRead' || action === 'mcpOperation' ? 'read' : 'manage';
  requireIntegrationPermission(context.principal, `nnd.configuration.${permission}`);
  if (request.method !== (permission === 'read' ? 'GET' : 'POST')) return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndConfigurationService;
  if (typeof service?.[action] !== 'function') throw new ContractError('nnd_mcp_unavailable', 'Native MCP configuration is unavailable.');
  const value = action === 'mcpRead' ? await service.mcpRead(context.principal)
    : action === 'mcpOperation' ? await service.mcpOperation(context.principal, operation[1])
      : await service[action](context.principal, await readJsonBody(request, 65536));
  if (value === null) return send(response, 404, { error: 'operation_not_found' });
  const safe = project(value, action);
  if (Buffer.byteLength(JSON.stringify(safe)) > 2 * 1024 * 1024) throw invalid();
  return send(response, 200, safe);
}

function project(value, action) {
  const source = action === 'mcpPreview' ? value?.view : value;
  if (!source || source.scope !== 'user' || source.application !== 'not_applied') throw invalid();
  const identity = { installation_id: id(source.installation_id), data_id: id(source.data_id), scope: 'user' };
  if (action === 'mcpRead' || action === 'mcpPreview') {
    if (!source || !Array.isArray(source.servers) || source.servers.length > 16) throw invalid();
    const servers = source.servers.map(server => {
      if (!server || !/^[A-Za-z0-9_-]{1,64}$/u.test(server.id ?? '')
        || !['stdio', 'streamable_http'].includes(server.transport)
        || typeof server.enabled !== 'boolean' || typeof server.trusted !== 'boolean') throw invalid();
      const fields = { id: server.id, transport: server.transport, enabled: server.enabled, trusted: server.trusted };
      for (const key of ['timeout_ms', 'connect_timeout_ms', 'list_timeout_ms', 'call_timeout_ms', 'shutdown_timeout_ms']) {
        if (server[key] !== undefined) {
          if (!Number.isSafeInteger(server[key]) || server[key] < 0) throw invalid();
          fields[key] = server[key];
        }
      }
      return fields;
    });
    const view = { schema_version: '1.0', ...identity, source_state: 'present',
      source_revision: revision(source.source_revision), resolution_revision: revision(source.resolution_revision),
      project_shadowed: source.project_shadowed === true, application: 'not_applied', servers };
    if (action === 'mcpRead') return view;
    if (value.valid !== true || value.expected_revision !== view.source_revision
      || value.resolution_revision !== view.resolution_revision || !value.change
      || !['create', 'patch', 'delete'].includes(value.change.op)) throw invalid();
    return { valid: true, expected_revision: view.source_revision, resolution_revision: view.resolution_revision,
      application: 'not_applied', change: { op: value.change.op, id: id(value.change.id) }, view };
  }
  if (!['saved', 'unpublished', 'unknown'].includes(value.persistence)) throw invalid();
  return { ...identity, operation_id: id(value.operation_id), persistence: value.persistence,
    persisted_revision: value.persisted_revision === null ? null : revision(value.persisted_revision),
    before_revision: revision(value.before_revision), application: 'not_applied',
    next_action: value.persistence === 'saved' ? 'activate_setup_or_restart_native_service' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw invalid(); return value; }
function revision(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalid(); return value; }
