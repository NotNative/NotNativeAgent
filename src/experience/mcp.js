// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { McpManager } from '../mcp-manager.js';
import { ToolRegistry } from '../tool-registry.js';

export function configuredMcpStatus(config, engine) {
  const runtime = new Map(engine.mcp.status().map((item) => [item.id, item]));
  return config.mcpServers.map((server) => ({
    ...server, runtime: runtime.get(server.id)?.state ?? 'restart_required',
    capabilities: runtime.get(server.id)?.capabilities ?? {},
  }));
}

export async function testConfiguredMcpServer(options, id) {
  const server = options.config.mcpServers.find((entry) => entry.id === id);
  if (!server) throw new ContractError('mcp_server_missing', `MCP server ${id} is not configured`);
  const registry = new ToolRegistry(options.config.workspaceRoot, {
    webSearchConfigPath: options.webSearchConfigPath, webSearchClient: options.webSearchClient,
  });
  await registry.initialize();
  const manager = new McpManager({
    registry, configs: [{ ...server, enabled: true }], transportFactory: options.transportFactory,
  });
  try {
    const [result] = await manager.initialize();
    const status = manager.status()[0];
    if (result.status !== 'ready') {
      throw new ContractError(status.lastError ?? 'mcp_connection_failed', 'MCP server connection test failed', true);
    }
    const tools = registry.snapshot().filter((item) => item.source === `mcp:${id}`).map((item) => item.name);
    return { ...result, protocolVersion: status.protocolVersion, capabilities: status.capabilities, tools };
  } finally { await manager.close(); }
}
