// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { mcpOverlay, valueOverlay } from './overlays.js';

export async function handleMcpCommand(argument, workspace) {
  const values = argument.split(/\s+/u).filter(Boolean);
  if (values.length === 0) return openManager(workspace);
  if (values[0] === 'add-http') return addHttp(values, workspace);
  if (values[0] === 'add-stdio') return addStdio(values, workspace);
  if (['resources', 'prompts'].includes(values[0]) && values.length === 2) {
    const result = values[0] === 'resources'
      ? await workspace.activeEngine().mcp.listResources(values[1])
      : await workspace.activeEngine().mcp.listPrompts(values[1]);
    workspace.projection.openOverlay(valueOverlay(`mcp-${values[0]}`, `MCP ${values[0]} · ${values[1]}`, result));
    return;
  }
  if (values[0] === 'read' && values.length === 3) {
    const result = await workspace.activeEngine().mcp.readResource(values[1], values[2]);
    workspace.projection.openOverlay(valueOverlay('mcp-resource', `MCP resource · ${values[1]}`, result));
    return;
  }
  if (values[0] === 'prompt' && values.length >= 3) {
    const result = await workspace.activeEngine().mcp.getPrompt(values[1], values[2], parseArguments(values.slice(3).join(' ')));
    workspace.projection.openOverlay(valueOverlay('mcp-prompt', `MCP prompt · ${values[1]}/${values[2]}`, result));
    return;
  }
  if (values.length !== 2 || !['test', 'enable', 'disable', 'delete'].includes(values[0])) {
    throw new ContractError('mcp_command_invalid', 'use /mcp, add-http, add-stdio, test|enable|disable|delete ID, resources|prompts ID, read ID URI, or prompt ID NAME [JSON]');
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
  await workspace.addMcpServer({ id: values[1], transport: 'streamable_http', endpoint: values[2], credentialEnv: values[3] });
  openManager(workspace, values[1], `${values[1]} added; open a new conversation to connect.`);
}

async function addStdio(values, workspace) {
  if (values.length < 3) throw new ContractError('mcp_command_invalid', 'use /mcp add-stdio ID COMMAND [ARG ...]');
  await workspace.addMcpServer({ id: values[1], transport: 'stdio', command: values[2], args: values.slice(3) });
  openManager(workspace, values[1], `${values[1]} added; open a new conversation to connect.`);
}

function openManager(workspace, selectedId, message) {
  workspace.projection.openOverlay(mcpOverlay(workspace.mcpStatus(), {
    selectedId, message, canManage: workspace.projection.active().role === 'primary',
  }));
}

function parseArguments(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw new ContractError('mcp_prompt_arguments_invalid', 'MCP prompt arguments must be one JSON object');
  }
}
