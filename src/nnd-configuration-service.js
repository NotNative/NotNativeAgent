// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readNndConfigurationSources, NND_CONFIGURATION_OPTIONS, resolveNndWorkspaceRoot, assertNndProjectWorkspace } from './nnd-configuration-sources.js';
import { resolveConfiguration } from './configuration-sources.js';
import { resolveManifest } from './config.js';
import { workspaceIsTrusted } from './experience/trust.js';
import { readManifestSnapshot, readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';
import { normalizeNndConfigurationOperations, applyNndConfigurationOperations, nndConfigurationOperationPaths,
  NND_CONFIGURATION_EDITABLE_FIELDS } from './nnd-configuration-intents.js';
import { createNndMcpConfigurationService } from './nnd-mcp-configuration.js';
import { createNndMcpAdvancedConfigurationService } from './nnd-mcp-advanced-routes.js';

const identityPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const revisionPattern = /^(?:absent|[a-f0-9]{64})$/u;
const readPermission = 'nnd.configuration.read';

export function createNndConfigurationService({ paths, installationId, dataId }) {
  if (!identityPattern.test(installationId ?? '') || !identityPattern.test(dataId ?? '') || !isAbsolute(paths?.config ?? '')) throw invalid();
  const identity = { installation_id: installationId, data_id: dataId, scope: 'user' };
  const path = join(paths.config, 'manifest.json');
  const read = async (principal) => {
    authorize(principal, readPermission);
    try { return internalSnapshot(await readNndConfigurationSources(paths), identity); }
    catch (error) {
      const raw = await readManifestSnapshot(path);
      return Object.freeze({ instanceId: installationId, installationId, dataId, scope: 'user',
        sourceRevision: raw.revision, sourceState: raw.state === 'missing' ? 'missing' : 'invalid',
        resolutionRevision: null, application: 'not_applied', failureCode: safeCode(error.code) });
    }
  };
  return Object.freeze({
    ...createNndMcpConfigurationService({ paths, identity }),
    nndMcpAdvancedConfigurationService:
      createNndMcpAdvancedConfigurationService({ paths, identity }),
    read,
    async preview(principal, input) {
      authorize(principal, readPermission); authorize(principal, 'nnd.configuration.manage');
      const request = normalizeRequest(input, identity, false);
      const context = await readNndConfigurationSources(paths);
      requireRevision(context, request);
      const next = candidate(context, request.operations);
      return Object.freeze({ valid: true, expected_revision: request.expected_revision,
        resolution_revision: context.resolutionRevision, application: 'not_applied',
        snapshot: internalSnapshot({ ...context, ...next }, identity) });
    },
    save: (principal, input) => saveConfiguration({ paths, identity, path }, principal, input),
    repair: (principal, input) => repairConfiguration({ paths, identity, path }, principal, input),
    async operation(principal, operationId) {
      authorize(principal, readPermission);
      if (!operationPattern.test(operationId ?? '')) throw invalid();
      const result = await readManifestOperation(path, operationKey(principal, identity, operationId));
      return result ? receipt(result, identity, operationId) : null;
    },
  });
}

async function saveConfiguration({ paths, identity, path }, principal, input) {
  authorize(principal, 'nnd.configuration.manage');
  const request = normalizeRequest(input, identity, true);
  let failure;
  const guarded = async (operation) => { try { return await operation(); } catch (error) { failure = error; throw error; } };
  try {
    const result = await transactManifest({ path, expectedRevision: request.expected_revision,
      operationId: operationKey(principal, identity, request.operation_id), payload: { ...identity, actor: principal.subjectId, request },
      transform: () => guarded(async () => {
        const context = await readNndConfigurationSources(paths);
        requireRevision(context, request);
        return candidate(context, request.operations).persistedSource.manifest;
      }),
      validate: (manifest) => guarded(async () => {
        const context = await readNndConfigurationSources(paths);
        requireRevision(context, request);
        candidate(context, request.operations, manifest);
      }) });
    return receipt(result, identity, request.operation_id);
  } catch (error) {
    if (error.code === 'manifest_validation_failed' && failure) throw sanitized(failure);
    throw error;
  }
}

async function repairConfiguration({ paths, identity, path }, principal, input) {
  authorize(principal, 'nnd.configuration.repair');
  const request = normalizeRepair(input, identity);
  let failure;
  const validate = async (document) => { try { await validateRepairLayers(paths, document); } catch (error) { failure = error; throw error; } };
  try {
    const result = await transactManifest({ path, expectedRevision: request.expected_revision,
      operationId: operationKey(principal, identity, request.operation_id), payload: { ...identity, actor: principal.subjectId, request },
      transform: async (raw) => {
        if (validNativeUser(raw)) {
          failure = new ContractError('nnd_configuration_repair_unnecessary', 'Valid selected configuration cannot be replaced through repair.');
          throw failure;
        }
        await validate(request.document);
        return request.document;
      }, validate });
    return receipt(result, identity, request.operation_id);
  } catch (error) {
    if (error.code === 'manifest_validation_failed' && failure) throw sanitized(failure);
    throw error;
  }
}

function normalizeRequest(input, identity, save) {
  const keys = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision', 'operations', ...(save ? ['operation_id'] : [])];
  assertRequest(input, identity, keys);
  if (!/^[a-f0-9]{64}$/u.test(input.expected_resolution_revision ?? '') || (save && !operationPattern.test(input.operation_id ?? ''))) throw invalid();
  return { ...identity, expected_revision: input.expected_revision, expected_resolution_revision: input.expected_resolution_revision,
    ...(save ? { operation_id: input.operation_id } : {}), operations: normalizeNndConfigurationOperations(input.operations) };
}

function assertRequest(input, identity, keys) {
  if (!record(input) || Object.keys(input).some((key) => !keys.includes(key))
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !revisionPattern.test(input.expected_revision ?? '')) throw invalid();
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw invalid(); }
  if (bytes > 65536) throw invalid();
}

function requireRevision(context, request) {
  if (context.persistedSource.revision !== request.expected_revision) throw new ContractError('manifest_revision_conflict', 'Reload the selected source before saving.');
  if (context.resolutionRevision !== request.expected_resolution_revision) throw new ContractError('nnd_configuration_resolution_conflict', 'Configuration overlays changed; refresh the resolved view.');
}

function candidate(context, operations, replacement) {
  const higher = context.sourceSnapshots.filter(({ name }) => name === 'project');
  for (const operation of operations) {
    if (operation.op === 'bind_route' && !userOwnsProvider(context.persistedSource.manifest, operation.provider_id)) {
      throw new ContractError('route_profile_missing', 'The selected user source does not own this provider profile.');
    }
    for (const field of nndConfigurationOperationPaths(operation)) {
      for (const source of higher) if (owns(source.manifest, field)) {
        throw new ContractError('configuration_source_shadowed', 'The setting belongs to a higher-precedence source.');
      }
    }
  }
  const manifest = replacement ?? applyNndConfigurationOperations(context.persistedSource.manifest, operations);
  const sourceSnapshots = context.sourceSnapshots.map((source) => source.name === 'user' ? { ...source, manifest } : source);
  const resolved = resolveConfiguration(sourceSnapshots, { manifestOptions: NND_CONFIGURATION_OPTIONS });
  return { ...resolved, sourceSnapshots, persistedSource: { ...context.persistedSource, manifest } };
}

function userOwnsProvider(manifest, id) {
  if (Array.isArray(manifest.providers)) return manifest.providers.some((provider) =>
    record(provider) && provider.id === id);
  return record(manifest.provider) && (manifest.provider.id ?? 'manifest-primary') === id;
}

function owns(manifest, path) {
  let cursor = manifest;
  for (const key of path.split('.')) {
    if (!record(cursor)) return true;
    if (!Object.hasOwn(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

function normalizeRepair(input, identity) {
  assertRequest(input, identity, ['installation_id', 'data_id', 'scope', 'expected_revision', 'operation_id', 'document']);
  if (!operationPattern.test(input.operation_id ?? '') || !record(input.document)) throw invalid();
  const document = structuredClone(input.document);
  const { provider, workspace_root: workspace, ...rest } = document;
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.length > 4096 || /[\u0000-\u001f\u007f]/u.test(workspace)
    || !record(provider) || Object.keys(provider).some((key) => !['id', 'display_name', 'endpoint', 'model', 'trust_zone'].includes(key))) throw invalid();
  const pending = Object.entries(rest).map(([field, value]) => ({ field, value })), operations = [];
  while (pending.length) {
    if (pending.length + operations.length > 128) throw invalid();
    const item = pending.pop();
    if (NND_CONFIGURATION_EDITABLE_FIELDS.includes(item.field)) operations.push({ op: 'set', ...item });
    else if (record(item.value) && NND_CONFIGURATION_EDITABLE_FIELDS.some((field) => field.startsWith(`${item.field}.`))) {
      for (const [key, value] of Object.entries(item.value)) pending.push({ field: `${item.field}.${key}`, value });
    } else throw invalid();
  }
  if (operations.length) normalizeNndConfigurationOperations(operations);
  resolveManifest(document, NND_CONFIGURATION_OPTIONS);
  return { ...identity, expected_revision: input.expected_revision, operation_id: input.operation_id, document };
}

function validNativeUser(manifest) {
  try {
    if (!record(manifest)) return false;
    resolveNndWorkspaceRoot(manifest.workspace_root);
    resolveManifest(manifest, NND_CONFIGURATION_OPTIONS); return true;
  } catch { return false; }
}

async function validateRepairLayers(paths, document) {
  const root = resolveNndWorkspaceRoot(document.workspace_root);
  const sources = [{ name: 'user', manifest: document }, { name: 'workspace', manifest: { workspace_root: root } }];
  if (typeof paths.trustedWorkspaces === 'string' && await workspaceIsTrusted(paths.trustedWorkspaces, root)) {
    const path = join(root, '.nna', 'settings.json');
    let handle;
    try { handle = await open(path, 'r'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (handle) {
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1048576) throw invalid();
        const bytes = Buffer.alloc(1048577); let count = 0;
        while (count < bytes.length) {
          const read = await handle.read(bytes, count, bytes.length - count, null); if (!read.bytesRead) break; count += read.bytesRead;
        }
        if (count > 1048576) throw invalid();
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
        assertNndProjectWorkspace(manifest, root);
        sources.push({ name: 'project', manifest });
      } finally { await handle.close(); }
    }
  }
  const result = resolveConfiguration(sources, { manifestOptions: NND_CONFIGURATION_OPTIONS });
  assertNndProjectWorkspace({ workspace_root: result.config.workspaceRoot }, root);
}

function internalSnapshot(context, identity) {
  // Security: this internal object requires the dedicated allowlist projector before HTTP serialization.
  return Object.freeze({ ...context, instanceId: identity.installation_id, installationId: identity.installation_id,
    dataId: identity.data_id, scope: 'user', sourceRevision: context.persistedSource.revision, sourceState: 'present', application: 'not_applied' });
}

function receipt(result, identity, operationId) {
  return Object.freeze({ ...identity, operation_id: operationId, persistence: result.persistence,
    persisted_revision: result.persistedRevision, before_revision: result.beforeRevision, application: 'not_applied',
    next_action: result.persistence === 'saved' ? 'activate_setup_or_restart_native_service' : 'inspect_native_operation',
    replayed: result.replayed, replay_window: result.replayWindow });
}

function operationKey(principal, identity, id) {
  const key = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndcfg_${key}_${id}`;
}
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || principal.subjectId.length > 256 || !principal.subjectId.trim()
    || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeCode(code) { return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'nnd_setup_configuration_invalid'; }
function sanitized(error) { return new ContractError(safeCode(error.code), 'Native configuration validation failed.'); }
function invalid() { return new ContractError('nnd_configuration_request_invalid', 'Native configuration request is invalid or unsupported.'); }
