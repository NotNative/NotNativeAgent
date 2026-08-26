// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const STATUS_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 65_000;
const MAX_SERVERS = 128;
const MAX_SERVER_ID_CHARACTERS = 64;
const MAX_TARGET_CHARACTERS = 2_048;
const MAX_TOOLS = 512;
const MAX_TOOL_NAME_CHARACTERS = 256;

export function mcpControlDefinitions(control) {
  if (!control) return [];
  return [statusDefinition(control), testDefinition(control)];
}

function statusDefinition(control) {
  return {
    name: 'nna.mcp_status', version: 1,
    purpose: 'Inspect configured MCP servers and whether each is active in this conversation. Use this instead of searching the workspace for NNA configuration.',
    sideEffect: 'read_only', scope: 'mcp_control', cancellation: true, timeoutMs: STATUS_TIMEOUT_MS,
    inputSchema: objectSchema({}, []),
    validate: async (args) => {
      requireExactObject(args, []);
      return { args: {}, resolved: { source: 'nna_mcp_configuration' } };
    },
    executor: async (_request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const snapshot = await control.status(signal);
      const configured = boundedServers(snapshot?.configured);
      const activeIds = new Set(boundedServers(snapshot?.active).map((server) => server.id));
      const servers = configured.map((server) => ({
        ...server, activation: activeIds.has(server.id) ? 'current_conversation' : 'new_conversation_required',
      }));
      return {
        content: JSON.stringify({
          servers,
          guidance: 'Use nna.mcp_test to validate a configured server and list its discovered tools. Newly discovered tools become invocable in a new conversation; restarting NNA is not required.',
        }, null, 2),
        metadata: { configured: servers.length, active: servers.filter((item) => item.activation === 'current_conversation').length },
      };
    },
  };
}

function testDefinition(control) {
  return {
    name: 'nna.mcp_test', version: 1,
    purpose: 'Test one configured MCP server and list its discovered tools without invoking any of those tools.',
    sideEffect: 'read_only', scope: 'mcp_control', cancellation: false, timeoutMs: TEST_TIMEOUT_MS,
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1, maxLength: MAX_SERVER_ID_CHARACTERS, description: 'Required configured MCP server id returned by nna.mcp_status.' },
    }, ['id']),
    validate: async (args) => {
      requireExactObject(args, ['id']);
      if (typeof args.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(args.id)) {
        throw new ContractError('mcp_server_id_invalid', 'MCP server id is invalid');
      }
      return { args: { id: args.id }, resolved: { source: 'configured_mcp_server', serverId: args.id } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const result = await control.test(request.args.id, signal);
      const tools = boundedToolNames(result.tools);
      return {
        content: JSON.stringify({
          id: request.args.id, status: result.status, protocol_version: result.protocolVersion ?? null,
          capabilities: result.capabilities ?? {}, tools,
        }, null, 2),
        metadata: { id: request.args.id, status: result.status, tools: tools.length },
      };
    },
  };
}

function boundedServers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SERVERS).filter((server) => server && typeof server === 'object')
    .map((server) => ({
    id: String(server.id).slice(0, MAX_SERVER_ID_CHARACTERS), enabled: server.enabled !== false,
    transport: server.transport === 'stdio' ? 'stdio' : 'streamable_http',
    target: String(server.endpoint ?? server.command ?? '').slice(0, MAX_TARGET_CHARACTERS),
    authentication: hasAuthentication(server) ? 'configured' : 'none',
  }));
}

function boundedToolNames(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string')
    .slice(0, MAX_TOOLS).map((item) => item.slice(0, MAX_TOOL_NAME_CHARACTERS)) : [];
}

function hasAuthentication(server) {
  if (server.credential || (typeof server.credentialEnv === 'string' && server.credentialEnv.length > 0)) return true;
  return server.headerEnv && typeof server.headerEnv === 'object'
    && !Array.isArray(server.headerEnv) && Object.keys(server.headerEnv).length > 0;
}

function requireExactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ContractError('tool_schema_invalid', 'MCP control tool arguments are invalid');
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
