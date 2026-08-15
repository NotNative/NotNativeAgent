// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { HttpMcpTransport, MCP_CURRENT_VERSION, StdioMcpTransport } from './mcp-transport.js';
import { VERSION } from './product.js';

const STATES = new Set(['disabled', 'connecting', 'authenticating', 'ready', 'degraded', 'failed', 'reconnecting', 'closed']);
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 50;
const MAX_MCP_PAGES = 64;
const MAX_MCP_TOOLS = 4_096;
const MAX_MCP_OUTPUT_BYTES = 1_048_576;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_DESCRIPTION_BYTES = 4_096;

export class McpManager {
  constructor(options) {
    this.registry = options.registry;
    this.configs = options.configs;
    this.transportFactory = options.transportFactory ?? createTransport;
    this.connections = new Map();
    this.lifecycle = new AbortController();
    this.initialization = null;
    this.closed = false;
  }

  async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = Promise.allSettled(this.configs.map((config) => this.#connect(config, this.lifecycle.signal)))
      .then((results) => results.map((_result, index) => {
        const connection = this.connections.get(this.configs[index].id);
        return {
          id: this.configs[index].id, status: connection.state,
          ...(connection.lastError ? { reason: connection.lastError } : {}),
        };
      }));
    return this.initialization;
  }

  status() {
    return Object.freeze([...this.connections.values()].map((item) => Object.freeze({
      id: item.config.id, state: item.state, capabilities: item.capabilities,
      protocolVersion: item.protocolVersion, transport: item.config.transport,
      address: item.config.endpoint ?? item.config.command ?? null,
      credentialRef: item.config.credentialEnv ?? null,
      headerRefs: Object.freeze({ ...(item.config.headerEnv ?? {}) }),
      trusted: item.config.trusted, lastError: item.lastError ?? null,
    })));
  }

  listResources(id, cursor = null, signal) {
    return this.#attributedRequest(id, 'resources/list', cursor ? { cursor } : {}, signal);
  }

  readResource(id, uri, signal) {
    return this.#attributedRequest(id, 'resources/read', { uri }, signal);
  }

  listPrompts(id, cursor = null, signal) {
    return this.#attributedRequest(id, 'prompts/list', cursor ? { cursor } : {}, signal);
  }

  getPrompt(id, name, args = {}, signal) {
    return this.#attributedRequest(id, 'prompts/get', { name, arguments: args }, signal);
  }

  async reconnect(id, attempts = MAX_RECONNECT_ATTEMPTS, signal) {
    const prior = this.connections.get(id);
    if (!prior || !prior.config.enabled) throw new ContractError('mcp_unavailable', 'MCP server is unavailable');
    prior.state = 'reconnecting';
    this.registry.revokeSource(`mcp:${id}`);
    await bounded((closeSignal) => prior.transport?.close(closeSignal), prior.config.shutdownTimeoutMs, signal).catch(() => undefined);
    for (let attempt = 0; attempt < Math.min(MAX_RECONNECT_ATTEMPTS, attempts); attempt += 1) {
      if (attempt > 0) await reconnectDelay(RECONNECT_BASE_DELAY_MS * (2 ** (attempt - 1)), signal);
      try { await this.#connect(prior.config, signal); return this.connections.get(id); } catch (error) {
        if (error.retryable !== true) break;
      }
    }
    this.connections.get(id).state = 'failed';
    throw new ContractError('mcp_reconnect_failed', 'MCP reconnect attempts were exhausted', true);
  }

  async handleNotification(id, notification, signal) {
    if (notification?.method !== 'notifications/tools/list_changed') return false;
    const connection = this.connections.get(id);
    if (!connection || connection.state !== 'ready') return false;
    const tools = await discoverTools(connection, connection.config.listTimeoutMs, signal);
    if (connection.state !== 'ready') return false;
    this.registry.revokeSource(`mcp:${id}`);
    this.#installTools(connection, tools);
    connection.capabilities = { ...connection.capabilities, tools: tools.length > 0 };
    return true;
  }

  async close() {
    this.closed = true;
    this.lifecycle.abort();
    await Promise.allSettled([...this.connections.values()].map(async (connection) => {
      connection.state = 'closed';
      this.registry.revokeSource(`mcp:${connection.config.id}`);
      try { await bounded((signal) => connection.transport?.close(signal), connection.config.shutdownTimeoutMs); }
      catch (error) { connection.lastError = error.code ?? 'mcp_shutdown_failed'; }
    }));
  }

  async #connect(config, parentSignal) {
    const connection = { config, state: config.enabled ? 'connecting' : 'disabled', capabilities: {} };
    this.connections.set(config.id, connection);
    if (!config.enabled) return;
    try {
      connection.transport = this.transportFactory(config);
      connection.transport.onNotification?.((notification) => {
        connection.refresh = Promise.resolve(connection.refresh)
          .then(() => this.handleNotification(config.id, notification)).catch((error) => {
          this.registry.revokeSource(`mcp:${config.id}`);
          connection.lastError = error.code ?? 'mcp_capability_refresh_failed';
          connection.state = error.retryable === true ? 'degraded' : 'failed';
        });
        return connection.refresh;
      });
      await bounded((signal) => connection.transport.open(signal), config.connectTimeoutMs, parentSignal);
      if (config.credentialEnv || Object.keys(config.headerEnv).length > 0) connection.state = 'authenticating';
      connection.protocolVersion = connection.transport.protocolVersion ?? MCP_CURRENT_VERSION;
      await negotiate(connection, config.listTimeoutMs, parentSignal);
      const tools = await discoverTools(connection, config.listTimeoutMs, parentSignal);
      if (this.closed) throw new ContractError('mcp_cancelled', 'MCP startup was cancelled');
      connection.capabilities = { ...connection.capabilities, tools: tools.length > 0 };
      this.#installTools(connection, tools);
      connection.state = 'ready';
    } catch (error) {
      this.registry.revokeSource(`mcp:${config.id}`);
      connection.lastError = error.code ?? 'mcp_failure';
      connection.state = this.closed || error.code === 'mcp_cancelled'
        ? 'closed' : error.retryable === true ? 'degraded' : 'failed';
      await bounded((signal) => connection.transport?.close(signal), config.shutdownTimeoutMs).catch(() => undefined);
      throw error;
    }
  }

  async #attributedRequest(id, method, params, signal) {
    const connection = this.connections.get(id);
    if (!connection || connection.state !== 'ready') {
      throw new ContractError('mcp_unavailable', 'MCP server is not ready', true);
    }
    let result;
    try {
      result = await bounded((deadlineSignal) => connection.transport.request(
        method, params, signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal,
      ), connection.config.callTimeoutMs, signal);
    } catch (error) {
      this.#recordCallFailure(connection, error);
      throw error;
    }
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > MAX_MCP_OUTPUT_BYTES) {
      throw new ContractError('mcp_output_too_large', 'MCP context response exceeded bound');
    }
    return Object.freeze({ serverId: id, method, untrusted: true, result: structuredClone(result) });
  }

  #installTools(connection, tools) {
    const version = (connection.toolGeneration ?? 0) + 1;
    for (const tool of tools) {
      const prefix = `mcp.${connection.config.id}.`;
      const localName = `${prefix}${safeName(tool.name, MAX_TOOL_NAME_BYTES - prefix.length)}`;
      try { this.registry.installExternal({
        name: localName, version, purpose: boundedText(tool.description ?? tool.name, MAX_TOOL_DESCRIPTION_BYTES),
        sideEffect: effectFor(connection.config, tool.name), scope: 'external',
        cancellation: true, timeoutMs: connection.config.callTimeoutMs,
        inputSchema: tool.inputSchema, source: `mcp:${connection.config.id}`,
        credentialRefs: Object.freeze([
          connection.config.credentialEnv, ...Object.values(connection.config.headerEnv ?? {}),
        ].filter(Boolean)),
        attribution: { serverId: connection.config.id, remoteName: tool.name },
        executor: async (request, signal) => {
          try { return await executeTool(connection, tool.name, request.args, signal); }
          catch (error) { this.#recordCallFailure(connection, error); throw error; }
        },
      }); } catch (error) {
        connection.toolInstallFailures = (connection.toolInstallFailures ?? 0) + 1;
        connection.lastError ??= error?.code ?? 'mcp_tool_install_failed';
      }
    }
    connection.toolGeneration = version;
  }

  #recordCallFailure(connection, error) {
    if (!isConnectionFailure(error) || connection.state === 'closed') return;
    connection.lastError = error.code ?? 'mcp_call_failed';
    connection.state = error.retryable === true ? 'degraded' : 'failed';
    this.registry.revokeSource(`mcp:${connection.config.id}`);
  }
}

async function negotiate(connection, timeoutMs, parentSignal) {
  const result = await bounded((signal) => connection.transport.request('initialize', {
    protocolVersion: connection.protocolVersion, capabilities: {},
    clientInfo: { name: 'NotNativeAgent', version: VERSION },
  }, signal), timeoutMs, parentSignal);
  if (!result || typeof result.protocolVersion !== 'string' || result.protocolVersion.length > 64) {
    throw new ContractError('mcp_version_mismatch', 'MCP server did not negotiate a protocol version');
  }
  connection.protocolVersion = result.protocolVersion;
  assertProtocolVersion(result.protocolVersion);
  connection.transport.protocolVersion = result.protocolVersion;
  connection.capabilities = result.capabilities ?? {};
  await bounded(
    (signal) => Promise.resolve(connection.transport.notify?.('notifications/initialized', {}, signal)),
    timeoutMs, parentSignal,
  );
}

async function discoverTools(connection, timeoutMs, parentSignal) {
  const result = [];
  let cursor;
  for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
    const listed = await bounded(
      (signal) => connection.transport.request('tools/list', cursor ? { cursor } : {}, signal),
      timeoutMs, parentSignal,
    );
    const pageTools = listTools(listed);
    if (pageTools.length > MAX_MCP_TOOLS - result.length) {
      throw new ContractError('mcp_tool_limit', 'MCP tool count exceeded bound');
    }
    result.push(...pageTools);
    cursor = listed?.nextCursor;
    if (!cursor) return result;
  }
  throw new ContractError('mcp_pagination_limit', 'MCP tools/list pagination exceeded bound');
}

async function executeTool(connection, name, args, signal) {
  if (connection.state !== 'ready') throw new ContractError('mcp_unavailable', 'MCP server is not ready', true);
  const result = await bounded((deadlineSignal) => connection.transport.request(
    'tools/call', { name, arguments: args }, signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal,
  ), connection.config.callTimeoutMs, signal);
  if (result?.resultType === 'input_required') {
    throw new ContractError('mcp_input_required', 'MCP tool requires additional operator input');
  }
  return {
    content: boundedText(JSON.stringify({
      server: connection.config.id, untrusted: true,
      content: result?.content ?? [], structuredContent: result?.structuredContent ?? null,
      isError: result?.isError === true,
    }), MAX_MCP_OUTPUT_BYTES),
    metadata: { serverId: connection.config.id, remoteTool: name, untrusted: true },
  };
}

function listTools(result) {
  const tools = result?.tools;
  if (!Array.isArray(tools) || tools.length > MAX_MCP_TOOLS) throw new ContractError('mcp_malformed', 'MCP tools/list result is malformed');
  return tools.filter((tool) => tool && typeof tool.name === 'string' && tool.inputSchema?.type === 'object');
}

function effectFor(config, name) {
  const effect = config.effects[name];
  return ['read_only', 'reversible', 'irreversible', 'unknown'].includes(effect) ? effect : 'unknown';
}

function safeName(name, limit) {
  const safe = name.replaceAll(/[^A-Za-z0-9_.-]/gu, '_').slice(0, Math.max(1, limit));
  if (!safe) throw new ContractError('mcp_invalid_tool_name', 'MCP tool name is invalid');
  return safe;
}

function boundedText(value, limit) {
  return String(value).slice(0, limit);
}

async function bounded(operation, timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ContractError('mcp_timeout', 'MCP operation timed out', true));
    }, timeoutMs);
  });
  const combined = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const cancelled = new Promise((_, reject) => {
    if (parentSignal?.aborted) reject(new ContractError('mcp_cancelled', 'MCP operation was cancelled'));
    else if (parentSignal) {
      abortHandler = () => reject(new ContractError('mcp_cancelled', 'MCP operation was cancelled'));
      parentSignal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  try { return await Promise.race([operation(combined), timeout, cancelled]); } finally {
    clearTimeout(timer);
    if (abortHandler) parentSignal.removeEventListener('abort', abortHandler);
  }
}

function assertProtocolVersion(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value > MCP_CURRENT_VERSION) {
    throw new ContractError('mcp_version_mismatch', `MCP protocol ${value} is not supported; newest supported revision is ${MCP_CURRENT_VERSION}`);
  }
}

function reconnectDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ContractError('mcp_cancelled', 'MCP reconnect was cancelled')); return; }
    const aborted = () => {
      clearTimeout(timer);
      reject(new ContractError('mcp_cancelled', 'MCP reconnect was cancelled'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, delayMs);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function isConnectionFailure(error) {
  if (error?.code === 'mcp_cancelled' || error?.code === 'mcp_remote_error' || error?.code === 'mcp_input_required') return false;
  return error?.retryable === true || [
    'mcp_closed', 'mcp_malformed', 'mcp_output_too_large', 'mcp_http_error',
    'missing_credential', 'mcp_timeout',
  ].includes(error?.code);
}

function createTransport(config) {
  if (config.transport === 'stdio') return new StdioMcpTransport(config);
  return new HttpMcpTransport(config);
}

export function assertMcpState(state) {
  if (!STATES.has(state)) throw new ContractError('invalid_mcp_state', 'invalid MCP connection state');
  return state;
}
