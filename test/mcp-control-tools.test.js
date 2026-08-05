// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';

test('root MCP controls expose configured activation and discovered tool names without credentials', async () => {
  const control = {
    status: async () => ({
      configured: [{
        id: 'memory', enabled: true, transport: 'streamable_http', endpoint: 'http://127.0.0.1:7788/mcp',
        credentialEnv: 'DO_NOT_EXPOSE_THIS_REFERENCE',
      }],
      active: [],
    }),
    test: async (id) => ({
      id, status: 'ready', protocolVersion: '2026-07-28', capabilities: { tools: true },
      tools: ['mcp.memory.memory_search', 'mcp.memory.memory_save'],
    }),
  };
  const registry = new ToolRegistry(process.cwd(), { mcpControl: control });
  await registry.initialize();
  const signal = new AbortController().signal;
  const status = await registry.definition('nna.mcp_status').executor({ args: {} }, signal);
  assert.match(status.content, /new_conversation_required/u);
  assert.doesNotMatch(status.content, /DO_NOT_EXPOSE/u);
  const tested = await registry.definition('nna.mcp_test').executor({ args: { id: 'memory' } }, signal);
  assert.match(tested.content, /mcp\.memory\.memory_search/u);
  assert.equal(tested.metadata.tools, 2);
});
