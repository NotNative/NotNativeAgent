// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { ContractError } from '../src/ids.js';

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
      tools: ['mcp_memory_memory_search', 'mcp_memory_memory_save'],
    }),
  };
  const registry = new ToolRegistry(process.cwd(), { mcpControl: control });
  await registry.initialize();
  const signal = new AbortController().signal;
  const status = await registry.definition('nna_mcp_status').executor({ args: {} }, signal);
  assert.match(status.content, /new_conversation_required/u);
  assert.doesNotMatch(status.content, /DO_NOT_EXPOSE/u);
  const tested = await registry.definition('nna_mcp_test').executor({ args: { id: 'memory' } }, signal);
  assert.match(tested.content, /mcp_memory_memory_search/u);
  assert.equal(tested.metadata.tools, 2);
});

test('MCP connection rejection is a successful test observation', async () => {
  const control = {
    status: async () => ({ configured: [], active: [] }),
    test: async () => { throw new ContractError('mcp_unreachable', 'connection refused', true); },
  };
  const registry = new ToolRegistry(process.cwd(), { mcpControl: control });
  await registry.initialize();
  const tested = await registry.definition('nna_mcp_test').executor(
    { args: { id: 'offline' } }, new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(tested.content), {
    id: 'offline', status: 'failed', protocol_version: null, capabilities: {}, tools: [],
    reason_code: 'mcp_unreachable', retryable: true,
  });
  assert.equal(tested.metadata.observation_outcome, 'connection_test_failed');
});

test('MCP test preserves invalid configured-server targets as tool failures', async () => {
  const control = {
    status: async () => ({ configured: [], active: [] }),
    test: async () => { throw new ContractError('mcp_server_missing', 'server is not configured'); },
  };
  const registry = new ToolRegistry(process.cwd(), { mcpControl: control });
  await registry.initialize();
  await assert.rejects(registry.definition('nna_mcp_test').executor(
    { args: { id: 'missing' } }, new AbortController().signal,
  ), { code: 'mcp_server_missing' });
});
