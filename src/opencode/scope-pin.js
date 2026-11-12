// SPDX-License-Identifier: Apache-2.0
/** Pin a model-selection manifest to the session's own scope: the caller derives
 *  its manifest from the spawn's working directory, while a restored session's
 *  scope is the journal's own. The selection may change routes and providers; it
 *  may not move the session's workspace, persistence, mission, MCP, or host scope. */
export function withSessionScope(manifest, engineConfig) {
  return {
    ...manifest,
    workspace_root: engineConfig.workspaceRoot,
    persistence: engineConfig.persistence,
    ...(engineConfig.mission ? { mission: engineConfig.mission } : {}),
    mcp_servers: engineConfig.mcpServers,
    ...(engineConfig.executionManifest ? {
      allowed_capabilities: [...engineConfig.executionManifest.allowedCapabilities],
      allowed_tools: [...engineConfig.executionManifest.allowedTools ?? []],
      disconnect_policy: engineConfig.executionManifest.disconnectPolicy,
    } : {}),
  };
}
