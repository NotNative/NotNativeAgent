// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { McpManager } from '../mcp-manager.js';
import { ToolRegistry } from '../tool-registry.js';

const MCP_RESTART_REQUIRED = 'restart_required';
const MCP_READY = 'ready';
const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function configuredMcpStatus(config, engine) {
  const configured = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
  const status = typeof engine?.mcp?.status === 'function' ? engine.mcp.status() : [];
  const runtime = new Map((Array.isArray(status) ? status : []).map((item) => [item.id, item]));
  return configured.map((server) => ({
    ...server, runtime: runtime.get(server.id)?.state ?? MCP_RESTART_REQUIRED,
    capabilities: runtime.get(server.id)?.capabilities ?? {},
  }));
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
