// SPDX-License-Identifier: Apache-2.0
/** User-manifest MCP edits. Existing private fields stay inside NNA. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readNndConfigurationSources, NND_CONFIGURATION_OPTIONS } from './nnd-configuration-sources.js';
import { resolveConfiguration } from './configuration-sources.js';
import { readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const OPERATION = /^[A-Za-z0-9_-]{1,64}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const DEADLINES = ['timeout_ms', 'connect_timeout_ms', 'list_timeout_ms', 'call_timeout_ms', 'shutdown_timeout_ms'];
const MAX_REQUEST = 65536;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new ContractError('nnd_mcp_request_invalid', 'Native MCP request is invalid or unsupported.');

export function createNndMcpConfigurationService({ paths, identity }) {
  const path = join(paths.config, 'manifest.json');
  return {
    async mcpRead(principal) {
      authorize(principal, 'nnd.configuration.read');
      const context = await readNndConfigurationSources(paths);
      return view(context, identity);
    },
    async mcpPreview(principal, input) {
      authorize(principal, 'nnd.configuration.read');
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, false);
      const context = await readNndConfigurationSources(paths);
      requireCurrent(context, request);
      const next = candidate(context, request.change);
      return { valid: true, expected_revision: request.expected_revision,
        resolution_revision: request.expected_resolution_revision, application: 'not_applied',
        change: { op: request.change.op, id: request.change.id }, view: view(next, identity) };
    },
    async mcpSave(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, true);
      let failure;
      const guarded = async task => { try { return await task(); } catch (error) { failure = error; throw error; } };
      try {
        const result = await transactManifest({ path, expectedRevision: request.expected_revision,
          operationId: operationKey(principal, identity, request.operation_id),
          payload: { contract: 'nnd-mcp-v1', identity, actor: principal.subjectId, request },
          transform: () => guarded(async () => {
            const context = await readNndConfigurationSources(paths);
            requireCurrent(context, request);
            return candidate(context, request.change).persistedSource.manifest;
          }),
          validate: manifest => guarded(async () => {
            const context = await readNndConfigurationSources(paths);
            requireCurrent(context, request);
            candidate(context, request.change, manifest);
          }) });
        return receipt(result, identity, request.operation_id);
      } catch (error) {
        if (error.code === 'manifest_validation_failed' && failure) throw safeFailure(failure);
        throw error;
      }
    },
    async mcpOperation(principal, operationId) {
      authorize(principal, 'nnd.configuration.read');
      if (!OPERATION.test(operationId ?? '')) throw invalid();
      const found = await readManifestOperation(path, operationKey(principal, identity, operationId));
      return found ? receipt(found, identity, operationId) : null;
    },
  };
}

function normalize(input, identity, save) {
  const allowed = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision', 'change',
    ...(save ? ['operation_id'] : [])];
  if (!record(input) || Object.keys(input).some(key => !allowed.includes(key))
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !REVISION.test(input.expected_revision ?? '') || !REVISION.test(input.expected_resolution_revision ?? '')
    || save && !OPERATION.test(input.operation_id ?? '')) throw invalid();
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw invalid(); }
  if (bytes > MAX_REQUEST) throw invalid();
  return { ...identity, expected_revision: input.expected_revision,
    expected_resolution_revision: input.expected_resolution_revision,
    ...(save ? { operation_id: input.operation_id } : {}), change: normalizeChange(input.change) };
}

function normalizeChange(value) {
  if (!record(value) || !ID.test(value.id ?? '') || !['create', 'patch', 'delete'].includes(value.op)) throw invalid();
  if (value.op === 'delete') {
    if (Object.keys(value).some(key => !['op', 'id'].includes(key))) throw invalid();
    return { op: 'delete', id: value.id };
  }
  if (!record(value.fields) || Object.keys(value).some(key => !['op', 'id', 'fields'].includes(key))) throw invalid();
  if (value.op === 'patch') {
    const fields = value.fields;
    if (!Object.keys(fields).length || Object.keys(fields).some(key => key !== 'enabled' && !DEADLINES.includes(key))
      || Object.hasOwn(fields, 'enabled') && typeof fields.enabled !== 'boolean') throw invalid();
    for (const key of DEADLINES) if (Object.hasOwn(fields, key)
      && (!Number.isSafeInteger(fields[key]) || fields[key] < 0)) throw invalid();
    return { op: 'patch', id: value.id, fields: structuredClone(fields) };
  }
  const fields = value.fields;
  if (!['stdio', 'streamable_http'].includes(fields.transport)
    || Object.keys(fields).some(key => !['transport', 'command', 'args', 'endpoint'].includes(key))) throw invalid();
  if (fields.transport === 'stdio') {
    if (Object.hasOwn(fields, 'endpoint') || typeof fields.command !== 'string' || !fields.command.trim()
      || fields.command.length > 4096 || /[\u0000-\u001f\u007f]/u.test(fields.command)
      || fields.args !== undefined && (!Array.isArray(fields.args) || fields.args.length > 64
        || fields.args.some(item => typeof item !== 'string' || item.length > 256))) throw invalid();
    return { op: 'create', id: value.id, fields: { transport: 'stdio', command: fields.command,
      ...(fields.args ? { args: [...fields.args] } : {}) } };
  }
  if (Object.hasOwn(fields, 'command') || Object.hasOwn(fields, 'args') || !endpoint(fields.endpoint)) throw invalid();
  return { op: 'create', id: value.id, fields: { transport: 'streamable_http', endpoint: fields.endpoint } };
}

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
function requireCurrent(context, request) {
  if (context.persistedSource.revision !== request.expected_revision) throw new ContractError('manifest_revision_conflict', 'Reload the selected source.');
  if (context.resolutionRevision !== request.expected_resolution_revision) throw new ContractError('nnd_configuration_resolution_conflict', 'Reload the resolved configuration.');
}
function candidate(context, change, replacement) {
  if (context.sourceSnapshots.some(source => source.name === 'project' && Object.hasOwn(source.manifest, 'mcp_servers'))) {
    throw new ContractError('configuration_source_shadowed', 'Trusted project MCP configuration owns the effective array.');
  }
  const manifest = replacement ?? applyChange(context.persistedSource.manifest, change);
  const sourceSnapshots = context.sourceSnapshots.map(source => source.name === 'user' ? { ...source, manifest } : source);
  const resolved = resolveConfiguration(sourceSnapshots, { manifestOptions: NND_CONFIGURATION_OPTIONS });
  return { ...resolved, sourceSnapshots, persistedSource: { ...context.persistedSource, manifest },
    resolutionRevision: context.resolutionRevision };
}
function applyChange(raw, change) {
  const next = structuredClone(raw);
  const entries = next.mcp_servers === undefined ? [] : next.mcp_servers;
  if (!Array.isArray(entries) || entries.length > 16) throw invalid();
  const index = entries.findIndex(entry => entry?.id === change.id);
  if (change.op === 'create') {
    if (index !== -1 || entries.length >= 16) throw new ContractError('nnd_mcp_conflict', 'MCP server already exists or capacity is full.');
    entries.push({ id: change.id, ...change.fields, enabled: false, trusted: false });
  } else if (index === -1) throw new ContractError('nnd_mcp_conflict', 'MCP server no longer exists.');
  else if (change.op === 'delete') entries.splice(index, 1);
  else Object.assign(entries[index], change.fields);
  next.mcp_servers = entries;
  return next;
}
function view(context, identity) {
  const entries = context.persistedSource.manifest.mcp_servers ?? [];
  if (!Array.isArray(entries)) throw invalid();
  return { schema_version: '1.0', ...identity, source_state: 'present',
    source_revision: context.persistedSource.revision, resolution_revision: context.resolutionRevision,
    project_shadowed: context.sourceSnapshots.some(source => source.name === 'project' && Object.hasOwn(source.manifest, 'mcp_servers')),
    application: 'not_applied', servers: entries.map(item => ({ id: item.id, transport: item.transport,
      enabled: item.enabled === true, trusted: item.trusted === true,
      ...Object.fromEntries(DEADLINES.filter(key => item[key] !== undefined).map(key => [key, item[key]])) })) };
}
function operationKey(principal, identity, id) {
  const key = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndmcp_${key}_${id}`;
}
function receipt(result, identity, operationId) {
  return { ...identity, operation_id: operationId, persistence: result.persistence,
    persisted_revision: result.persistedRevision, before_revision: result.beforeRevision,
    application: 'not_applied', next_action: result.persistence === 'saved' ? 'activate_setup_or_restart_native_service' : 'inspect_native_operation',
    replayed: result.replayed, replay_window: result.replayWindow };
}
function safeFailure(error) {
  const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code) ? error.code : 'nnd_mcp_unavailable';
  return new ContractError(code, 'Native MCP configuration validation failed.');
}
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}
