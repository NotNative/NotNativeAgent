// SPDX-License-Identifier: Apache-2.0
/** Native MCP advanced-fields projection over /v1/nnd/configuration/mcp/advanced.
 * Why: the plain MCP read serves only the public operator fields (id, transport,
 * enabled, trusted, the five deadlines) and honest changes keep the sensitive
 * remainder out of every projection. The 20261006-15 census nevertheless pins
 * 21 advanced mcp_servers[*] fields (the credential bindings, the header maps,
 * tool effects, the stdio command surface, the endpoint, the protocol version),
 * and the operator page must show them — as observations, without becoming an
 * offline oracle for SECRET VALUES. Grammar: presence rows never serve an
 * inner value ({present: true} or a bounded count); the inner projection adds
 * references (env name / secret:<id>#<field>), header and tool map entries,
 * and the command/endpoint values, all behind nnd.configuration.manage — the
 * write-class right, exactly like the manifest save — while presence stays
 * behind the read right. Validators stay authoritative: the projection reads
 * the source manifest through the resolved configuration and serves it
 * verbatim; it never validates or second-guesses the bytes.
 */
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { send } from './secret-broker-server.js';
import { credentialReference, environmentCredential } from './credential-bindings.js';
import { readNndConfigurationSources } from './nnd-configuration-sources.js';

const BASE = '/v1/nnd/configuration/mcp/advanced';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const invalid = () => new ContractError('nnd_mcp_advanced_request_invalid', 'Native MCP advanced request is invalid.');
const projection = () => new ContractError('nnd_mcp_advanced_projection_invalid', 'Native MCP advanced projection refused a drifted grammar.');

export function createNndMcpAdvancedConfigurationService({ paths, identity }) {
  if (typeof paths?.config !== 'string' || !ID.test(identity?.installation_id ?? '')
    || !ID.test(identity?.data_id ?? '')) throw invalid();
  return Object.freeze({
    async presence(principal) {
      requireIntegrationPermission(principal, 'nnd.configuration.read');
      const context = await readNndConfigurationSources(paths);
      return presenceView(context, identity);
    },
    async inner(principal) {
      requireIntegrationPermission(principal, 'nnd.configuration.manage');
      const context = await readNndConfigurationSources(paths);
      return innerView(context, identity, presenceView(context, identity));
    },
  });
}

function bindReference(server) {
  try { return credentialReference(server.credential) ?? null; } catch { return 'unreadable'; }
}

function envCredentialReference(name) {
  try { return credentialReference(environmentCredential(name)); } catch { return 'unreadable'; }
}

function headerReferences(server) {
  const rows = [];
  for (const [header, binding] of Object.entries(server.headerCredentials ?? {})) {
    let reference;
    try { reference = credentialReference(binding); } catch { reference = 'unreadable'; }
    rows.push({ header, reference, field: binding?.field ?? null });
  }
  return rows.sort((left, right) => left.header.localeCompare(right.header));
}

function headerEnvironment(server) {
  return Object.entries(server.headerEnv ?? {})
    .map(([header, name]) => ({ header, name }))
    .sort((left, right) => left.header.localeCompare(right.header));
}

function toolEffects(server) {
  return Object.entries(server.effects ?? {})
    .map(([tool, effect]) => ({ tool, effect: effect === true ? 'allowed' : effect === false ? 'denied' : 'unknown' }))
    .sort((left, right) => left.tool.localeCompare(right.tool));
}

function transportSurface(server) {
  if (server.transport === 'stdio') {
    return { command: server.command ?? null, args: [...(server.args ?? [])],
      cwd: server.cwd ?? null, endpoint: null };
  }
  return { command: null, args: null, cwd: null, endpoint: server.endpoint ?? null };
}

function presenceView(context, identity) {
  const manifest = context.persistedSource.manifest;
  const entries = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers : [];
  const rows = entries.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id ?? '')) throw invalid();
    const credential = 'credential' in item || 'credential_env' in item;
    const headers = 'header_credentials' in item ? Object.keys(item.header_credentials ?? {}).length : null;
    return { id: item.id,
      has_credential: credential, has_credential_target: 'credential_target' in item,
      header_credential_count: headers,
      has_header_env: 'header_env' in item,
      tool_effect_count: 'tool_effects' in item ? Object.keys(item.tool_effects ?? {}).length : null,
      has_protocol_version: 'protocol_version' in item,
      has_command: 'command' in item, has_args: 'args' in item, has_cwd: 'cwd' in item,
      has_endpoint: 'endpoint' in item };
  });
  return { schema_version: '1.0', ...identity, source_state: 'present',
    source_revision: context.persistedSource.revision,
    resolution_revision: context.resolutionRevision,
    project_shadowed: context.sourceSnapshots.some((source) => source.name === 'project'
      && Object.hasOwn(source.manifest, 'mcp_servers')),
    application: 'not_applied', servers: rows };
}

function innerView(context, identity, presence) {
  const resolved = context.config.mcpServers ?? [];
  const rows = resolved.map((item, index) => ({
    id: item.id,
    credential: item.credential ? bindReference(item) : (item.credentialEnv
      ? envCredentialReference(item.credentialEnv) : null),
    credential_target: item.credentialTarget ?? null,
    header_credentials: headerReferences(item),
    header_env: headerEnvironment(item),
    tool_effects: toolEffects(item),
    protocol_version: item.protocolVersion ?? '2026-07-28',
    surface: transportSurface(item),
    presence: presence.servers[index],
  }));
  return { schema_version: '1.0', ...identity,
    source_revision: presence.source_revision, resolution_revision: presence.resolution_revision,
    project_shadowed: presence.project_shadowed, application: 'not_applied', servers: rows };
}

export function projectMcpAdvanced(value, expect) {
  if (expect === 'inner') return projectInner(value);
  return projectPresence(value);
}

/** Shared envelope: identity trio, scope, revisions, shadowing, servers array. */
function envelope(value, sourceState) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== (sourceState
      ? 'application,data_id,installation_id,project_shadowed,'
        + 'resolution_revision,schema_version,scope,servers,source_revision,source_state'
      : 'application,data_id,installation_id,project_shadowed,'
        + 'resolution_revision,schema_version,scope,servers,source_revision')
    || value.schema_version !== '1.0' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user'
    || value.application !== 'not_applied'
    || typeof value.source_revision !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.source_revision)
    || !/^(?:absent|[a-f0-9]{64})$/u.test(value.resolution_revision ?? '')
    || (sourceState === true ? value.source_state !== 'present' : false)
    || typeof value.project_shadowed !== 'boolean'
    || !Array.isArray(value.servers)) throw projection();
  return value;
}

function projectPresence(value) {
  envelope(value, true);
  for (const row of value.servers) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'has_args,has_command,'
        + 'has_credential,has_credential_target,has_cwd,has_endpoint,'
        + 'has_header_env,has_protocol_version,header_credential_count,'
        + 'id,tool_effect_count'
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(row.id ?? '')
      || typeof row.has_credential !== 'boolean'
      || typeof row.has_credential_target !== 'boolean'
      || typeof row.has_header_env !== 'boolean'
      || typeof row.has_protocol_version !== 'boolean'
      || typeof row.has_command !== 'boolean'
      || typeof row.has_args !== 'boolean'
      || typeof row.has_cwd !== 'boolean'
      || typeof row.has_endpoint !== 'boolean'
      || (row.header_credential_count !== null && !Number.isSafeInteger(row.header_credential_count))
      || (row.tool_effect_count !== null && !Number.isSafeInteger(row.tool_effect_count))) throw projection();
  }
  return value;
}

function projectInner(value) {
  envelope(value, false);
  for (const row of value.servers) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'credential,credential_target,'
        + 'header_credentials,header_env,id,'
        + 'presence,protocol_version,surface,tool_effects'
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(row.id ?? '')
      || (row.credential !== null && typeof row.credential !== 'string')
      || (row.credential_target !== null && typeof row.credential_target !== 'string')
      || !Array.isArray(row.header_credentials)
      || !row.header_credentials.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'field,header,reference'
        && typeof entry.header === 'string'
        && (entry.reference === 'unreadable' || typeof entry.reference === 'string')
        && (entry.field === null || typeof entry.field === 'string'))
      || !Array.isArray(row.header_env)
      || !row.header_env.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'header,name'
        && typeof entry.header === 'string' && typeof entry.name === 'string')
      || !Array.isArray(row.tool_effects)
      || !row.tool_effects.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'effect,tool'
        && typeof entry.tool === 'string'
        && ['allowed', 'denied', 'unknown'].includes(entry.effect))
      || typeof row.protocol_version !== 'string'
      || !row.surface || typeof row.surface !== 'object' || Array.isArray(row.surface)
      || Object.keys(row.surface).sort().join(',') !== 'args,command,cwd,endpoint'
      || (row.surface.command !== null && typeof row.surface.command !== 'string')
      || (row.surface.cwd !== null && typeof row.surface.cwd !== 'string')
      || (row.surface.endpoint !== null && typeof row.surface.endpoint !== 'string')
      || (row.surface.args !== null && !Array.isArray(row.surface.args))
      || (Array.isArray(row.surface.args) && !row.surface.args.every((item) => typeof item === 'string'))
      || row.presence === null || typeof row.presence !== 'object' || Array.isArray(row.presence)) {
      throw projection();
    }
  }
  return value;
}

export async function dispatchNndMcpAdvancedRequest(request, response, context) {
  if (context.url.pathname !== BASE) return false;
  const inner = request.headers['x-nnd-inner'] === 'inner';
  requireIntegrationPermission(context.principal,
    inner ? 'nnd.configuration.manage' : 'nnd.configuration.read');
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const service = context.nndMcpAdvancedConfigurationService
    ?? context.nndConfigurationService?.nndMcpAdvancedConfigurationService;
  if (!service || typeof service.presence !== 'function' || typeof service.inner !== 'function') {
    throw new ContractError('nnd_mcp_unavailable', 'Native MCP configuration is unavailable.');
  }
  const value = inner ? await service.inner(context.principal) : await service.presence(context.principal);
  const projected = projectMcpAdvanced(value, inner ? 'inner' : 'presence');
  if (Buffer.byteLength(JSON.stringify(projected)) > 65536) throw invalid();
  return send(response, 200, projected);
}
