// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { containsSecret } from './memory.js';

const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;
const CALLBACK_PATH = '/api/agent-tool/callback';
const MAX_REPLY_BYTES = 262_144;
const MEMORY_ACTION_TIMEOUT_MS = 55_000;

/** A managed capability exists only in the NND-owned child, never in standalone NNA. */
export function nndAgentToolCallbackFromEnvironment(environment) {
  const rawUrl = environment.NNA_NND_AGENT_TOOL_URL;
  const token = environment.NNA_NND_AGENT_TOOL_TOKEN;
  if (rawUrl === undefined && token === undefined) return null;
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new ContractError('nnd_agent_tool_callback_invalid', 'NND memory callback URL is invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
    || url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password
    || typeof token !== 'string' || !TOKEN.test(token)) {
    throw new ContractError('nnd_agent_tool_callback_invalid', 'NND memory callback is invalid');
  }
  return Object.freeze({ url: url.href, token });
}

/** The launch secret must not remain in the long-lived NNA process environment. */
export function consumeNndAgentToolCallbackFromEnvironment(environment) {
  try { return nndAgentToolCallbackFromEnvironment(environment); }
  finally {
    if (environment === process.env) {
      delete process.env.NNA_NND_AGENT_TOOL_URL;
      delete process.env.NNA_NND_AGENT_TOOL_TOKEN;
    }
  }
}

const SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['read', 'list', 'save', 'delete'],
      description: 'Read one full entry, list title summaries, save or consolidate an entry, or delete one entry.' },
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        memoryId: { type: 'string', minLength: 1, maxLength: 128,
          description: 'Required for delete and preferred for read: exact memory ID from a list result.' },
        title: { type: 'string', minLength: 1, maxLength: 60,
          description: 'Fallback lookup for read; required with body for save.' },
        body: { type: 'string', minLength: 1, maxLength: 2000,
          description: 'Full durable text required for save; explains conditions and exceptions.' },
        type: { type: 'string', enum: ['fact', 'preference', 'reference'],
          description: 'Optional memory type. The server defaults to fact.' },
        scope: { type: 'string', enum: ['global', 'project', 'both'],
          description: 'Optional scope. List reads both; save defaults to project; delete requires global or project.' },
      },
    },
  },
});

export function nndMemoryDefinition(callback, options = {}) {
  if (!callback || typeof callback.url !== 'string' || typeof callback.token !== 'string') {
    throw new ContractError('nnd_agent_tool_callback_invalid', 'NND memory callback is invalid');
  }
  const fetcher = options.fetcher ?? fetch;
  return {
    name: 'openchamber_memory', version: 1,
    purpose: 'Read project or global memory from the connected NND desktop before relying on its titles, save durable knowledge, or delete a stale entry.',
    sideEffect: 'unknown', scope: 'memory', cancellation: true, timeoutMs: MEMORY_ACTION_TIMEOUT_MS,
    maxOutputBytes: MAX_REPLY_BYTES, inputSchema: SCHEMA,
    validate: async (args) => ({ args: validateMemoryArgs(args), resolved: { surface: 'nnd-managed-memory' } }),
    executor: async (request, signal) => {
      if (signal?.aborted) throw new ContractError('tool_cancelled', 'memory request was cancelled');
      const response = await requestNndMemory(callback, fetcher, request.args, signal, options.contextDirectory);
      if (!response.ok) throw await failedNndMemory(response);
      const bounded = await readNndMemoryReply(response);
      if (!plainObject(bounded.value)) throw new ContractError('nnd_agent_tool_reply_invalid', 'NND memory reply was invalid');
      return { content: JSON.stringify(bounded.value), metadata: { action: request.args.action, surface: 'nnd-managed-memory' } };
    },
  };
}

function validateMemoryArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ContractError('tool_schema_invalid', 'memory tool requires a JSON object');
  }
  const action = args.action;
  const parameters = args.parameters === undefined ? {} : plainParameters(args.parameters);
  if (!['read', 'list', 'save', 'delete'].includes(action)) throw invalidAction(action);
  if (['read', 'delete'].includes(action)
    && (hasString(parameters, 'memoryId') === hasString(parameters, 'title') || action === 'delete' && hasString(parameters, 'title'))) {
    throw invalidAction(action);
  }
  if (action === 'save' && (!hasString(parameters, 'title') || !hasString(parameters, 'body'))) throw invalidAction(action);
  if (action === 'save' && containsSecret(`${parameters.title}\n${parameters.body}`)) {
    throw new ContractError('memory_secret_rejected', 'secret-like content cannot be saved');
  }
  if (action === 'save' && parameters.memoryId !== undefined) throw invalidAction(action);
  if (action === 'save' && parameters.scope !== undefined
    && parameters.scope !== 'global' && parameters.scope !== 'project') throw invalidAction(action);
  if (action === 'save' && parameters.type !== undefined
    && !['fact', 'preference', 'reference'].includes(parameters.type)) throw invalidAction(action);
  if (action === 'delete' && parameters.scope !== 'global' && parameters.scope !== 'project') throw invalidAction(action);
  if (action === 'list' && parameters.scope !== undefined
    && !['global', 'project', 'both'].includes(parameters.scope)) throw invalidAction(action);
  if (action === 'read' && parameters.scope !== undefined && !['global', 'project'].includes(parameters.scope)) throw invalidAction(action);
  if (parameters.title !== undefined && !hasString(parameters, 'title')) throw new ContractError('tool_schema_invalid', 'memory title must be non-empty text');
  if (parameters.body !== undefined && !hasString(parameters, 'body')) throw new ContractError('tool_schema_invalid', 'memory body must be non-empty text');
  return { action, parameters: parameters === undefined ? {} : { ...parameters } };
}

function plainParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('tool_schema_invalid', 'memory parameters must be a JSON object');
  }
  return value;
}

function invalidAction(action) {
  return new ContractError('tool_schema_invalid', `OpenChamber memory ${action} parameters are invalid`);
}

function hasString(parameters, field) {
  return typeof parameters[field] === 'string' && parameters[field].length > 0;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestNndMemory(callback, fetcher, args, signal, contextDirectorySource) {
  const contextDirectory = typeof contextDirectorySource === 'function'
    ? contextDirectorySource() : contextDirectorySource;
  if (typeof contextDirectory !== 'string' || contextDirectory.length < 1 || contextDirectory.length > 4096) {
    throw new ContractError('nnd_agent_tool_unavailable', 'OpenChamber memory workspace context is unavailable');
  }
  try {
    return await fetcher(callback.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${callback.token}` },
      body: JSON.stringify({
        tool: 'openchamber_memory', input: { action: `memory.${args.action}`, parameters: args.parameters },
        contextDirectory,
      }), signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'memory request was cancelled', { cause: error });
    throw new ContractError('nnd_agent_tool_unavailable', 'OpenChamber memory callback is unavailable', { cause: error });
  }
}

async function failedNndMemory(response) {
  const bounded = await readNndMemoryReply(response);
  const friendly = Number.isInteger(bounded?.status) && [400, 404, 503].includes(bounded.status)
    ? bounded.value : null;
  const message = typeof friendly?.error === 'string' && friendly.error.length > 0
    ? friendly.error.slice(0, 500) : `OpenChamber memory action failed (${bounded?.status ?? 'unknown response'})`;
  return new ContractError('nnd_agent_tool_failed', message);
}

async function readNndMemoryReply(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new ContractError('nnd_agent_tool_reply_large', 'NND memory reply exceeded its bound');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('nnd_agent_tool_reply_invalid', 'NND memory reply was empty');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) throw new ContractError('nnd_agent_tool_reply_large', 'NND memory reply exceeded its bound');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContractError('nnd_agent_tool_reply_invalid', 'NND memory reply was invalid'); }
  return { status: response.status, value };
}
