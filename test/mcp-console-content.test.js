// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiProjection } from '../src/tui-model.js';
import { handleMcpCommand } from '../src/tui-mcp-command.js';

function workspace() {
  const calls = [];
  const mcp = {
    async listResources(id) { calls.push(['resources', id]); return { serverId: id, untrusted: true, result: { resources: [{ uri: 'memory://one' }] } }; },
    async readResource(id, uri) { calls.push(['read', id, uri]); return { serverId: id, untrusted: true, result: { contents: [{ uri, text: 'bounded' }] } }; },
    async listPrompts(id) { calls.push(['prompts', id]); return { serverId: id, untrusted: true, result: { prompts: [{ name: 'recall' }] } }; },
    async getPrompt(id, name, args) { calls.push(['prompt', id, name, args]); return { serverId: id, untrusted: true, result: { description: name } }; },
  };
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', {}, 'primary');
  return { calls, projection, activeEngine: () => ({ mcp }), mcpStatus: () => [] };
}

test('MCP Console browses attributed untrusted resources and prompts', async () => {
  const target = workspace();
  await handleMcpCommand('resources nnm', target);
  assert.equal(target.projection.overlay.kind, 'mcp-resources');
  assert.match(target.projection.overlay.lines.join('\n'), /untrusted: true/u);
  await handleMcpCommand('read nnm memory://one', target);
  await handleMcpCommand('prompts nnm', target);
  await handleMcpCommand('prompt nnm recall {"topic":"project"}', target);
  assert.deepEqual(target.calls, [
    ['resources', 'nnm'], ['read', 'nnm', 'memory://one'], ['prompts', 'nnm'],
    ['prompt', 'nnm', 'recall', { topic: 'project' }],
  ]);
});

test('MCP prompt arguments must be a JSON object', async () => {
  await assert.rejects(handleMcpCommand('prompt nnm recall []', workspace()), { code: 'mcp_prompt_arguments_invalid' });
});
