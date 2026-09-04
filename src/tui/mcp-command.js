// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { mcpOverlay, valueOverlay } from './overlays.js';

const RESOURCE_COMMAND = 'resources';
const PROMPT_COMMAND = 'prompts';
const INSPECTION_COMMANDS = Object.freeze([RESOURCE_COMMAND, PROMPT_COMMAND]);
const MUTATION_COMMANDS = Object.freeze(['test', 'enable', 'disable', 'delete']);
const STREAMABLE_HTTP_TRANSPORT = 'streamable_http';
const STDIO_TRANSPORT = 'stdio';
const MAX_ARGUMENT_JSON_CHARS = 65_536;
const MAX_ARGUMENT_DEPTH = 64;
const MAX_ARGUMENT_NODES = 10_000;
const MCP_USAGE = 'use /mcp, add-http, add-stdio, test|enable|disable|delete ID, resources|prompts ID, read ID URI, or prompt ID NAME [JSON]';

export async function handleMcpCommand(argument, workspace) {
  const values = argument.split(/\s+/u).filter(Boolean);
  if (values.length === 0) return openManager(workspace);
  if (values[0] === 'add-http') return addHttp(values, workspace);
  if (values[0] === 'add-stdio') return addStdio(values, workspace);
  if (INSPECTION_COMMANDS.includes(values[0]) && values.length === 2) {
    const mcp = activeMcp(workspace);
    const result = values[0] === RESOURCE_COMMAND
      ? await mcp.listResources(values[1])
      : await mcp.listPrompts(values[1]);
    workspace.projection.openOverlay(valueOverlay(`mcp-${values[0]}`, `MCP ${values[0]} · ${values[1]}`, result));
    return;
  }
  if (values[0] === 'read' && values.length === 3) {
    const result = await activeMcp(workspace).readResource(values[1], values[2]);
    workspace.projection.openOverlay(valueOverlay('mcp-resource', `MCP resource · ${values[1]}`, result));
    return;
  }
  if (values[0] === 'prompt' && values.length >= 3) {
    const argumentJson = argument.replace(/^\s*\S+\s+\S+\s+\S+\s*/u, '');
    const result = await activeMcp(workspace).getPrompt(values[1], values[2], parseArguments(argumentJson));
    workspace.projection.openOverlay(valueOverlay('mcp-prompt', `MCP prompt · ${values[1]}/${values[2]}`, result));
    return;
  }
  if (values.length !== 2 || !MUTATION_COMMANDS.includes(values[0])) {
    throw new ContractError('mcp_command_invalid', MCP_USAGE);
  }
  if (values[0] === 'test') {
    const result = await workspace.testMcpServer(values[1]);
    workspace.projection.openOverlay(valueOverlay('mcp-test', `MCP test · ${values[1]}`, result));
    return;
  }
  if (values[0] === 'delete') await workspace.deleteMcpServer(values[1]);
  else await workspace.setMcpEnabled(values[1], values[0] === 'enable');
  openManager(workspace, values[1], `${values[1]} ${values[0]}d; open a new conversation to apply.`);
}

async function addHttp(values, workspace) {
  if (values.length < 3 || values.length > 4) throw new ContractError('mcp_command_invalid', 'use /mcp add-http ID ENDPOINT [CREDENTIAL_ENV]');
  await workspace.addMcpServer({ id: values[1], transport: STREAMABLE_HTTP_TRANSPORT, endpoint: values[2], credentialEnv: values[3] });
  openManager(workspace, values[1], `${values[1]} added; open a new conversation to connect.`);
}

async function addStdio(values, workspace) {
  if (values.length < 3) throw new ContractError('mcp_command_invalid', 'use /mcp add-stdio ID COMMAND [ARG ...]');
  await workspace.addMcpServer({ id: values[1], transport: STDIO_TRANSPORT, command: values[2], args: values.slice(3) });
  openManager(workspace, values[1], `${values[1]} added; open a new conversation to connect.`);
}

function openManager(workspace, selectedId, message) {
  workspace.projection.openOverlay(mcpOverlay(workspace.mcpStatus(), {
    selectedId, message, canManage: workspace.projection.active().role === 'primary',
  }));
}

function parseArguments(text) {
  if (!text) return {};
  if (text.length > MAX_ARGUMENT_JSON_CHARS) {
    throw new ContractError('mcp_prompt_arguments_invalid', 'MCP prompt arguments exceed the size limit');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    validateArgumentShape(value);
    return value;
  } catch {
    throw new ContractError('mcp_prompt_arguments_invalid', 'MCP prompt arguments must be a JSON object within the nesting limit');
  }
}

function activeMcp(workspace) {
  const engine = workspace.activeEngine?.();
  if (!engine?.mcp) throw new ContractError('mcp_engine_unavailable', 'no active conversation is available for MCP access');
  return engine.mcp;
}

function validateArgumentShape(value) {
  const pending = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (current.depth > MAX_ARGUMENT_DEPTH || nodes > MAX_ARGUMENT_NODES) throw new Error('argument limit exceeded');
    if (!current.value || typeof current.value !== 'object') continue;
    for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
}
