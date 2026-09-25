// SPDX-License-Identifier: Apache-2.0
/** A configuration-only MCP inventory. Never project transport destinations or credentials. */
export function nndMcpInventory(config) {
  return Object.freeze({
    version: 1,
    state: 'configured',
    servers: Object.freeze(config.mcpServers.map((server) => Object.freeze({
      id: server.id,
      transport: server.transport,
      enabled: server.enabled,
      trusted: server.trusted,
    }))),
  });
}
