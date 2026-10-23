// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { McpManager } from '../mcp-manager.js';
import { ToolRegistry } from '../tool-registry.js';
import { CredentialResolver } from '../credential-bindings.js';
import { withoutMcpServer } from '../provider/route-configuration.js';
import { deleteManagedMcpCredential, isManagedMcpCredentialReference } from '../mcp-credentials.js';

const MCP_RESTART_REQUIRED = 'restart_required';
const MCP_READY = 'ready';
const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CREDENTIAL_CLEANUP = new WeakSet();
const MCP_MUTATIONS = new WeakMap();

export function configuredMcpStatus(config, engine) {
  const configured = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
  const status = typeof engine?.mcp?.status === 'function' ? engine.mcp.status() : [];
  const runtime = new Map((Array.isArray(status) ? status : []).map((item) => [item.id, item]));
  return configured.map((server) => ({
    ...server, runtime: runtime.get(server.id)?.state ?? MCP_RESTART_REQUIRED,
    capabilities: runtime.get(server.id)?.capabilities ?? {},
  }));
}

export async function deleteConfiguredMcpServer(workspace, id, publish) {
  const server = workspace.config.mcpServers.find((entry) => entry.id === id);
  const next = withoutMcpServer(workspace.config, id);
  const result = await publish(next);
  const references = [...new Set(mcpCredentialReferences(server).filter(isManagedMcpCredentialReference))];
  // Invariant: a per-manifest edit cannot prove global non-use of a user-wide managed credential.
  return references.length > 0
    ? { ...result, credentialCleanup: { status: 'retained', references } } : result;
}

export function isMcpCredentialCleanupPending(workspace) { return CREDENTIAL_CLEANUP.has(workspace); }

export async function withMcpCredentialMutation(workspace, operation) {
  if (CREDENTIAL_CLEANUP.has(workspace)) throw new ContractError('mcp_credentials_busy', 'MCP credential cleanup is in progress');
  MCP_MUTATIONS.set(workspace, (MCP_MUTATIONS.get(workspace) ?? 0) + 1);
  try { return await operation(); }
  finally {
    const remaining = MCP_MUTATIONS.get(workspace) - 1;
    if (remaining > 0) MCP_MUTATIONS.set(workspace, remaining);
    else MCP_MUTATIONS.delete(workspace);
  }
}

export async function cleanupUnreferencedMcpCredential(workspace, reference, confirmUnshared, creatingSessions) {
  if (confirmUnshared !== true) {
    throw new ContractError('mcp_credential_confirmation_required', 'confirm that no other NNA configuration uses this credential');
  }
  if (CREDENTIAL_CLEANUP.has(workspace) || MCP_MUTATIONS.has(workspace)) {
    throw new ContractError('mcp_credentials_busy', 'MCP configuration or credential cleanup is in progress');
  }
  CREDENTIAL_CLEANUP.add(workspace);
  try {
    // Invariant: creations admitted before cleanup settle before the reference census; new creations are refused meanwhile.
    await Promise.allSettled([...creatingSessions.values()]);
    return await deleteUnreferencedMcpCredential(workspace, reference);
  } finally { CREDENTIAL_CLEANUP.delete(workspace); }
}

async function deleteUnreferencedMcpCredential(workspace, reference) {
  if (!isManagedMcpCredentialReference(reference)) {
    throw new ContractError('mcp_credential_reference_invalid', 'a managed MCP credential reference is required');
  }
  const configured = workspace.config.mcpServers.some((server) => mcpCredentialReferences(server).includes(reference));
  const active = [...workspace.sessions.values()].some((session) => session.engine.mcp?.configs
    ?.some((server) => mcpCredentialReferences(server).includes(reference)));
  if (configured || active) {
    throw new ContractError('mcp_credential_in_use', 'the MCP credential is still used by a configured or active server');
  }
  return deleteManagedMcpCredential(workspace.dataPaths, reference);
}

function mcpCredentialReferences(server) {
  return [server.credentialEnv, ...Object.values(server.headerEnv ?? {}),
    ...Object.values(server.headerCredentials ?? {}).map((binding) => binding?.source === 'environment' ? binding.name : null)];
}

export async function testConfiguredMcpServer(options, id) {
  if (!MCP_SERVER_ID_PATTERN.test(id ?? '') || !Array.isArray(options?.config?.mcpServers)) {
    throw new ContractError('mcp_server_invalid', 'MCP server id or configuration is invalid');
  }
  const server = options.config.mcpServers.find((entry) => entry.id === id);
  if (!server) throw new ContractError('mcp_server_missing', `MCP server ${id} is not configured`);
  const registry = new ToolRegistry(options.config.workspaceRoot, {
    webSearchConfigPath: options.webSearchConfigPath, webSearchClient: options.webSearchClient,
  });
  await registry.initialize();
  const manager = new McpManager({
    registry, configs: [{ ...server, enabled: true }], transportFactory: options.transportFactory,
    credentialResolver: new CredentialResolver({ secretBroker: options.secretBroker }),
  });
  let operationError = null;
  try {
    const [result] = await manager.initialize();
    const status = manager.status()[0];
    if (result.status !== MCP_READY) {
      throw new ContractError(status.lastError ?? 'mcp_connection_failed', 'MCP server connection test failed', true);
    }
    const tools = registry.snapshot().filter((item) => item.source === `mcp:${id}`).map((item) => item.name);
    return { ...result, protocolVersion: status.protocolVersion, capabilities: status.capabilities, tools };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    await manager.close().catch((error) => cleanupFailures.push(error));
    await registry.close().catch((error) => cleanupFailures.push(error));
    if (operationError) operationError.cleanupFailures = cleanupFailures;
    else if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'MCP connection test cleanup failed');
  }
}
